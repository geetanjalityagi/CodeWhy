from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Final, Optional, Protocol, runtime_checkable

from app.config import Settings, settings
from app.services.errors import DataSourceError
from app.providers.llm_provider import get_llm_provider
from app.schemas.common import CitationKind, DecisionState, EntityType, SourceType
from app.schemas.decisions import (
    Citation,
    DecisionDetail,
    DecisionListItem,
    DecisionListResponse,
    SourceRef,
)
from app.schemas.entities import Entity, EntityListResponse
from app.schemas.graph import GraphEdge, GraphNode, GraphResponse
from app.schemas.repository import (
    RepositoryCounts,
    RepositoryListResponse,
    RepositoryResponse,
)
from app.services.answer import generate_answer
from app.services.entity_resolution import (
    EntityCandidate,
    ResolutionOutcome,
    ResolutionResult,
    resolve_question,
)
from app.services.retrieval import retrieve_evidence
from app.stores.graph_store import BaseGraphStore, get_graph_store

if TYPE_CHECKING:
    from app.schemas.ask import AskRequest, AskResponse





class NotFoundError(DataSourceError):
    pass


@runtime_checkable
class DataSource(Protocol):
    def get_repository(self, repository_id: str) -> RepositoryResponse: ...

    def list_repositories(self) -> RepositoryListResponse: ...

    def search_entities(self, repository_id: str, query: str) -> EntityListResponse: ...

    def ask(self, repository_id: str, request: AskRequest) -> AskResponse: ...

    def get_decision(self, decision_id: str) -> DecisionDetail: ...

    def list_decisions(
        self,
        repository_id: str,
        entity_id: str | None = None,
        state: DecisionState | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> DecisionListResponse: ...

    def get_graph(self, repository_id: str, entity_id: str | None) -> GraphResponse: ...



#: Node properties too large or too internal for a UI payload. `embedding` is a
#: 384-float vector and `text` is a source's full corpus; `labels` is store plumbing.
_GRAPH_DROP_PROPS: Final[frozenset[str]] = frozenset({"embedding", "text", "labels"})

#: Relationship keys that are the edge itself rather than its properties. `rule` is
#: kept in `props` as well so an edge carries its rule and method together.
_GRAPH_EDGE_KEYS: Final[frozenset[str]] = frozenset({"from", "to", "type"})


def graph_node_props(node: dict) -> dict:
    """A node's properties, minus the huge or internal ones, for the /graph payload."""
    return {key: value for key, value in node.items() if key not in _GRAPH_DROP_PROPS}


def graph_edge_props(rel: dict) -> dict:
    """An edge's properties, excluding the endpoints, type and the dedicated `rule`."""
    return {key: value for key, value in rel.items() if key not in _GRAPH_EDGE_KEYS}


def _clean_date(value: Any) -> Optional[str]:
    """A stored date, or None when it is absent. An empty string is not a date."""
    text = str(value or "").strip()
    return text or None


def _clean_text(value: Any) -> Optional[str]:
    """A stored string, or None when it is absent. An empty string is not a value."""
    text = str(value or "").strip()
    return text or None


def _clean_int(value: Any) -> Optional[int]:
    """A stored count as an int, or None when it is absent. Zero is a real value."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def source_ref_for(node: dict) -> SourceRef:
    """Build a SourceRef from the stored node.

    Values that are genuinely absent stay absent; a placeholder would misattribute
    the decision, so a decision with no usable source is refused instead.
    """
    source_url = node.get("source_url") or ""
    raw_number = node.get("source_number")
    number = raw_number if isinstance(raw_number, int) and raw_number >= 0 else None

    # Derived unconditionally: the branch below reads derived_type even when the
    # node already carried a url and number, so binding it only inside the `if`
    # raised UnboundLocalError for any decision that did have a source.
    derived_url, derived_number, derived_type = from_source_id(node.get("source_id"))
    if not source_url or number is None:
        source_url = source_url or derived_url
        if number is None:
            number = derived_number

    raw_type = (node.get("source_type") or "").strip().lower()
    try:
        source_type = SourceType(raw_type)
    except ValueError:
        source_type = derived_type or SourceType.PULL_REQUEST

    if number is None or not source_url:
        raise DataSourceError(
            "decision carries no usable source reference; refusing to invent one"
        )
    return SourceRef(type=source_type, number=number, url=source_url)


def source_type_from_stored(raw: Any) -> Optional[SourceType]:
    """Map a stored source type onto the contract enum, case-insensitively.

    The cache stores kinds as ``pull_request`` while the contract spells them
    ``PullRequest``. An unrecognised value returns None so the caller falls back to
    the provenance derived from the source id instead of guessing a kind.
    """
    text = str(raw or "").strip()
    if not text:
        return None
    for member in SourceType:
        if text.lower() in (member.value.lower(), member.name.lower()):
            return member
    return None


def citations_for_decision(
    decision_id: str, evidence: list[dict[str, Any]]
) -> list[Citation]:
    """Build the citations behind a decision from its stored evidence.

    Each citation carries the verified quote, the URL it points at, and its author
    and timestamp. Evidence with no quote is dropped rather than cited blank: a
    citation that quotes nothing asserts nothing.
    """
    citations: list[Citation] = []
    for ev in evidence:
        quote = str(ev.get("quote") or "")
        if not quote.strip():
            continue
        url = str(ev.get("source_url") or "")
        kind = source_type_from_stored(ev.get("source_type"))
        if not url or kind is None:
            derived_url, _number, derived_type = from_source_id(ev.get("source_id"))
            url = url or derived_url
            if kind is None:
                kind = derived_type
        citations.append(
            Citation(
                id=f"cit_{ev.get('id', '')}",
                decision_id=decision_id,
                kind=CitationKind.SOURCE,
                quote=quote,
                source_url=url,
                source_type=kind or SourceType.PULL_REQUEST,
                author=ev.get("author"),
                timestamp=ev.get("timestamp"),
            )
        )
    return citations


def from_source_id(source_id: Any) -> tuple[str, Optional[int], SourceType]:
    """Derive provenance from a stable source id such as ``pr:owner/repo#123``.

    Returns empty values when the id does not carry enough information, so the
    caller refuses rather than guessing.
    """
    text = str(source_id or "")
    match = re.match(r"^(pr|pull_request|issue):(?P<owner>[^/]+)/(?P<repo>[^#]+)#(?P<number>\d+)$", text)
    if not match:
        return "", None, SourceType.PULL_REQUEST
    number = int(match.group("number"))
    kind = SourceType.ISSUE if text.startswith("issue") else SourceType.PULL_REQUEST
    segment = "issues" if kind is SourceType.ISSUE else "pull"
    url = f"https://github.com/{match.group('owner')}/{match.group('repo')}/{segment}/{number}"
    return url, number, kind


class GraphDataSource:
    """Production knowledge-graph data source querying Neo4j / InMemory graph store."""

    def __init__(self, cfg: Optional[Settings] = None, store: Optional[BaseGraphStore] = None) -> None:
        self.settings = cfg or settings
        self.store = store or get_graph_store(self.settings)
        self.provider = get_llm_provider(cfg=self.settings)

    @property
    def is_real(self) -> bool:
        """True only when both the store and the provider are real.

        Derived rather than declared, so swapping in a mock for a test or a
        misconfigured deployment can never leave the flag claiming otherwise.
        """
        return bool(getattr(self.store, "is_real", False)) and bool(
            getattr(self.provider, "is_real", False)
        )

    def _require_repository(self, repository_id: str) -> list[dict[str, Any]]:
        """Refuse a repository the graph has never seen.

        A repository with nothing in it is a different statement from a repository
        that cannot be reached. Only the latter is an infrastructure failure and
        only that one is allowed to surface as a 503.
        """
        entities = self.store.search_entities(repository_id, "")
        if not entities and not self._has_repository_node(repository_id):
            raise NotFoundError(f"repository {repository_id!r} not found")
        return entities

    def _has_repository_node(self, repository_id: str) -> bool:
        """Whether the graph holds a Repository node for this id.

        Resolved through `get_node` rather than a duck-typed `nodes` mapping, so the
        check works against Neo4j instead of silently reporting "no repository" and
        turning a real hit into a 404.
        """
        node = self._find_node(repository_id)
        return bool(node) and node.get("repo") == repository_id

    def _find_node(self, node_id: str) -> Optional[dict[str, Any]]:
        """Look a node up by id in whichever store is in use."""
        getter = getattr(self.store, "get_node", None)
        if callable(getter):
            return getter(node_id)
        nodes = getattr(self.store, "nodes", None)
        if isinstance(nodes, dict):
            return nodes.get(node_id)
        return None

    def _resolve_explicit_entity(self, repository_id: str, entity_id: str) -> ResolutionResult:
        """Resolve an entity a caller named, or refuse plainly.

        A caller who names an entity must get that entity or a clear refusal; falling
        back to text resolution would answer about a different entity than the one
        they named. An unknown id is `entity_not_found`, the same contract the fixture
        source follows.
        """
        node = self.store.get_entity(repository_id, entity_id)
        if node is None:
            return ResolutionResult(
                outcome=ResolutionOutcome.REFUSAL,
                reason_code="entity_not_found",
                error_message=f"entity {entity_id!r} is not in the graph",
            )
        return ResolutionResult(
            outcome=ResolutionOutcome.SUCCESS,
            entity=EntityCandidate(
                id=node.get("id", entity_id),
                name=node.get("name", ""),
                path=node.get("path", node.get("name", "")),
                entity_type=node.get("entity_type", "File"),
                score=1.0,
            ),
        )

    def _repository_response(self, repository_id: str, node: dict) -> RepositoryResponse:
        # Name and url come from the Repository node the build wrote, not from the id
        # string: the id is the slug the API addresses, and the real address lives on
        # the node as `url` with the raw `owner/name` in `full_name`.
        raw_name = node.get("full_name") or repository_id
        return RepositoryResponse(
            id=repository_id,
            name=node.get("name") or repository_id.rsplit("/", 1)[-1],
            url=node.get("url") or f"https://github.com/{raw_name}",
            counts=RepositoryCounts(
                decisions=self.store.count_nodes(repository_id, "Decision"),
                entities=self.store.count_nodes(repository_id, "CodeEntity"),
                pull_requests=self.store.count_nodes(repository_id, "PullRequest"),
                commits=self.store.count_nodes(repository_id, "Commit"),
            ),
            full_name=_clean_text(node.get("full_name")),
            owner=_clean_text(node.get("owner")),
            scope=_clean_text(node.get("scope")),
            prs_fetched=_clean_int(node.get("prs_fetched")),
            sources_analyzed=_clean_int(node.get("sources_analyzed")),
            prs_noise_skipped=_clean_int(node.get("prs_noise_skipped")),
            verified_decisions=_clean_int(node.get("verified_decisions")),
            last_rebuilt_at=_clean_text(node.get("last_rebuilt_at")),
            fixture=not self.is_real,
        )

    def get_repository(self, repository_id: str) -> RepositoryResponse:
        self._require_repository(repository_id)
        return self._repository_response(repository_id, self._find_node(repository_id) or {})

    def list_repositories(self) -> RepositoryListResponse:
        items = [
            self._repository_response(str(node.get("id", "")), node)
            for node in self.store.list_repositories()
        ]
        return RepositoryListResponse(items=items, fixture=not self.is_real)

    def search_entities(self, repository_id: str, query: str) -> EntityListResponse:
        raw_ents = self._require_repository(repository_id)
        if query.strip():
            raw_ents = self.store.search_entities(repository_id, query)
        entities_list: list[Entity] = []
        for e in raw_ents:
            try:
                etype = EntityType(e.get("entity_type", "File"))
            except ValueError:
                etype = EntityType.FILE
            entities_list.append(
                Entity(
                    id=e.get("id", e.get("name", "")),
                    type=etype,
                    label=e.get("name", ""),
                    path=e.get("path", e.get("name", "")),
                    decision_count=len(self.store.get_decisions_for_entity(e.get("id", ""))),
                )
            )
        return EntityListResponse(
            entities=entities_list,
            query=query,
            fixture=not self.is_real,
        )

    def ask(self, repository_id: str, request: AskRequest) -> AskResponse:
        all_entities = self._require_repository(repository_id)
        if request.entity_id is not None:
            resolution = self._resolve_explicit_entity(repository_id, request.entity_id)
        else:
            resolution = resolve_question(
                request.question, all_entities, repository_id, self.store
            )

        bundle = None
        if resolution.entity:
            bundle = retrieve_evidence(
                question=request.question,
                entity=resolution.entity.__dict__,
                store=self.store,
                cfg=self.settings,
            )

        return generate_answer(
            question=request.question,
            resolution=resolution,
            bundle=bundle,
            provider=self.provider,
            store=self.store,
            is_real=self.is_real,
            min_score=self.settings.min_score,
            cfg=self.settings,
            repository_id=repository_id,
        )

    def get_decision(self, decision_id: str) -> DecisionDetail:
        """Return one decision, or refuse. Nothing is invented for a missing id.

        An earlier implementation returned placeholder text with a synthetic
        pull/1 URL, which presented invented content as real history. A second one
        raised a plain DataSourceError, which the API reports as 503 and so claimed
        the database was broken when in fact the id simply does not exist.
        """
        node = self._find_node(decision_id)
        if not node:
            raise NotFoundError(f"decision {decision_id!r} not found")

        from app.services.answer import dedupe_citations

        citations = dedupe_citations(
            citations_for_decision(
                decision_id, self.store.get_evidence_for_decision(decision_id)
            )
        )
        return DecisionDetail(
            id=decision_id,
            summary=node.get("summary", ""),
            rationale=node.get("rationale"),
            state=DecisionState(node.get("state", "ACTIVE")),
            recorded_at=_clean_date(node.get("recorded_at")),
            effective_at=_clean_date(node.get("effective_at")),
            ended_at=_clean_date(node.get("ended_at")),
            source=source_ref_for(node),
            supersedes=node.get("supersedes") or [],
            superseded_by=node.get("superseded_by") or [],
            rule=node.get("rule"),
            probable_superseded_by=node.get("probable_superseded_by") or [],
            conflicts_with=node.get("conflicts_with") or [],
            reaffirms=node.get("reaffirms") or [],
            citations=citations,
            fixture=not self.is_real,
        )

    def list_decisions(
        self,
        repository_id: str,
        entity_id: str | None = None,
        state: DecisionState | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> DecisionListResponse:
        self._require_repository(repository_id)
        result = self.store.list_decisions(
            repository_id,
            entity_id=entity_id,
            state=state.value if state is not None else None,
            limit=limit,
            offset=offset,
        )
        items: list[DecisionListItem] = []
        for node in result["items"]:
            try:
                source_url = source_ref_for(node).url
            except DataSourceError:
                # A row whose source cannot be reconstructed is still listed; only its
                # link is absent. Dropping the row would hide a decision that exists.
                source_url = None
            items.append(
                DecisionListItem(
                    id=node.get("id", ""),
                    summary=node.get("summary", ""),
                    state=DecisionState(node.get("state", "ACTIVE")),
                    date=_clean_date(node.get("effective_at")),
                    source_url=source_url,
                    entities=[str(e) for e in (node.get("entities") or [])],
                    supersedes=node.get("supersedes") or [],
                    superseded_by=node.get("superseded_by") or [],
                    rule=node.get("rule"),
                )
            )
        return DecisionListResponse(
            items=items,
            total=result["total"],
            limit=limit,
            offset=offset,
            fixture=not self.is_real,
        )

    def get_graph(self, repository_id: str, entity_id: str | None) -> GraphResponse:
        self._require_repository(repository_id)
        if entity_id is not None and self.store.get_entity(repository_id, entity_id) is None:
            # An unknown entity is a 404. Returning an empty graph with 200 would
            # tell the caller the entity has no history when it is not in the graph.
            raise NotFoundError(f"entity {entity_id!r} not found")

        cap = self.settings.max_graph_nodes
        subgraph = self.store.get_subgraph(
            repo=repository_id,
            entity_id=entity_id,
            node_cap=cap,
        )

        nodes: list[GraphNode] = []
        known_ids: set[str] = set()
        # The store reports whether it stopped short of the graph it was asked for.
        # A caller that also hits the cap here, or drops a node to the cap, is
        # truncating too, so the flag is carried forward rather than declared false.
        truncated = bool(subgraph.get("truncated", False))

        for n in subgraph.get("nodes", []):
            nid = n.get("id", n.get("login", ""))
            if not nid or nid in known_ids:
                continue
            if len(nodes) >= cap:
                truncated = True
                continue
            known_ids.add(nid)
            ntype = n.get("labels", ["Node"])[0] if n.get("labels") else "Node"
            label = n.get("name", n.get("summary", nid))
            nodes.append(
                GraphNode(id=nid, label=label, type=ntype, props=graph_node_props(n))
            )

        edges: list[GraphEdge] = []
        for r in subgraph.get("relationships", []):
            src = r.get("from")
            tgt = r.get("to")
            if src in known_ids and tgt in known_ids:
                edges.append(
                    GraphEdge(
                        source=src,
                        target=tgt,
                        type=r.get("type", "CONNECTED"),
                        rule=r.get("rule"),
                        props=graph_edge_props(r),
                    )
                )

        return GraphResponse(
            nodes=nodes,
            edges=edges,
            truncated=truncated,
            fixture=not self.is_real,
        )


def _load_sqlite_into_graph_source(source: "GraphDataSource", cfg: Settings) -> None:
    """Populate an in-memory graph store from the SQLite cache.

    Called after a GraphDataSource is built with an InMemoryGraphStore when
    SQLITE_CACHE_PATH is set. The load runs synchronously at startup so every
    request after the first one reads fully-populated data.
    """
    import logging
    import sys
    from pathlib import Path as _P
    from app.stores.graph_store import InMemoryGraphStore

    log = logging.getLogger(__name__)
    if not isinstance(source.store, InMemoryGraphStore):
        return
    if not cfg.sqlite_cache_path:
        return

    cache_path = _P(cfg.sqlite_cache_path)
    if not cache_path.is_absolute() and not cache_path.exists():
        # The server often runs from backend/ while the cache lives at the repo root.
        # Try resolving the path relative to the repository root (parent of this file's
        # backend/app/services/ directory, going up three parents to get to repo root).
        repo_root = _P(__file__).resolve().parent.parent.parent.parent
        candidate = repo_root / cfg.sqlite_cache_path
        if candidate.exists():
            cache_path = candidate
    if not cache_path.exists():
        log.warning("SQLITE_CACHE_PATH=%s does not exist; skipping SQLite load", cache_path)
        return

    import os
    import shutil
    import tempfile

    if os.environ.get("VERCEL") or not os.access(cache_path, os.W_OK) or not os.access(cache_path.parent, os.W_OK):
        tmp_cache = _P(tempfile.gettempdir()) / f"codewhy_{cache_path.name}"
        if not tmp_cache.exists() or tmp_cache.stat().st_size != cache_path.stat().st_size:
            shutil.copyfile(cache_path, tmp_cache)
        cache_path = tmp_cache

    import sqlite3
    try:
        con = sqlite3.connect(cache_path)
        cur = con.cursor()
        repos = [r[0] for r in cur.execute("SELECT DISTINCT repo FROM commits WHERE repo IS NOT NULL").fetchall()]
        con.close()
    except Exception:
        repos = [cfg.sqlite_repo or "urllib3/urllib3"]
    if not repos:
        repos = [cfg.sqlite_repo or "urllib3/urllib3"]

    log.info("Loading SQLite cache %s for repos %s …", cache_path, repos)
    try:
        # scripts/ lives two levels above this file: backend/app/services/ -> repo root
        scripts_dir = str(_P(__file__).resolve().parent.parent.parent.parent / "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        from rebuild_graph import rebuild_graph  # type: ignore[import-not-found]

        for r in repos:
            rebuild_graph(r, cache_path, source.store, cfg=cfg)
        log.info(
            "SQLite load complete: %d nodes, %d relationships across %d repos",
            source.store.node_count(),
            source.store.relationship_count(),
            len(repos),
        )
    except Exception as exc:  # noqa: BLE001
        log.error("SQLite load failed: %s", exc)


def get_data_source(cfg: Settings) -> DataSource:
    if cfg.data_source == "fixture":
        from app.fixtures.source import FixtureDataSource

        return FixtureDataSource(cfg)
    if cfg.data_source == "graph":
        source = GraphDataSource(cfg)
        # Without a real store and a real provider this source can only invent
        # answers, so refuse rather than serve fabricated history. Mock mode is
        # available deliberately, and still reports fixture=true on every response.
        if not source.is_real and not cfg.allow_mock_providers:
            missing = []
            if not getattr(source.store, "is_real", False):
                missing.append("a real Neo4j store (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD)")
            if not getattr(source.provider, "is_real", False):
                missing.append("a real LLM provider (LLM_PROVIDER with credentials)")
            raise DataSourceError(
                "DATA_SOURCE=graph needs "
                + " and ".join(missing)
                + ". Set ALLOW_MOCK_PROVIDERS=true to run against the in-memory store "
                "and a mock LLM; every response then carries \"fixture\": true."
            )
        # When the store is in-memory and a SQLite cache is configured, pre-populate
        # it now so the first request already has data. This path is only taken once
        # because deps.py caches the data source at the process level.
        _load_sqlite_into_graph_source(source, cfg)
        return source

    raise DataSourceError(
        f"DATA_SOURCE={cfg.data_source!r} is not supported. Must be 'fixture' or 'graph'."
    )


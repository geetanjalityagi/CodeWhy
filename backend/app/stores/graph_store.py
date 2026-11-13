from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from typing import Any, Optional, Sequence

from app.config import Settings, settings
from app.graph.queries import (
    COUNT_DECISIONS_FOR_REPOSITORY,
    GET_DECISIONS_GOVERNING_ENTITY,
    GET_ENTITIES_FOR_DECISION,
    GET_SUBGRAPH_FOR_ENTITY,
    GET_SUBGRAPH_FOR_REPOSITORY,
    LIST_DECISIONS_FOR_REPOSITORY,
    SEARCH_DECISIONS_BY_SUMMARY,
    SEARCH_DECISIONS_BY_TEXT,
)
from app.graph.schema import (
    FULLTEXT_INDEX_QUERY,
    NODE_CONSTRAINTS,
    NODE_INDEXES,
    VECTOR_INDEX_QUERY,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Base Graph Store Interface
# ---------------------------------------------------------------------------

# Cypher cannot parameterise a label or a relationship type, so both are interpolated
# into the query text. These are the only values the store will ever interpolate, and
# anything else is refused rather than escaped: a query fragment arriving through
# either position would otherwise be executable Cypher.
ALLOWED_NODE_LABELS: frozenset[str] = frozenset({
    "Repository",
    "CodeEntity",
    "Decision",
    "Evidence",
    "Source",
    "PullRequest",
    "Issue",
    "Commit",
    "Document",
    "Discussion",
    "Person",
    "Incident",
})

ALLOWED_REL_TYPES: frozenset[str] = frozenset({
    "GOVERNS",
    "SUPPORTED_BY",
    "DECIDED_IN",
    "REVERTS",
    "SUPERSEDES",
    "REFERENCES",
    "PART_OF",
    "CONTAINS",
    "MODIFIED_IN",
    "AUTHORED",
    "REVIEWED",
    "OPPOSES",
    "CONFLICTS_WITH",
    "REAFFIRMS",
    "MOTIVATED_BY",
    "HAS_DISCUSSION",
})


def _require_allowed(value: str, allowed: frozenset[str], kind: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{kind} must be a string, got {type(value).__name__}")
    if value not in allowed:
        raise ValueError(f"{kind} {value!r} is not permitted")
    return value


class BaseGraphStore(ABC):
    #: True only for a store backed by a real database. An in-memory store holds
    #: nothing that came from a repository, so it must never imply otherwise.
    is_real: bool = True

    """Abstract interface for knowledge graph operations."""

    @abstractmethod
    def init_schema(self) -> None:
        """Create constraints and indexes."""
        ...

    @abstractmethod
    def merge_node(self, label: str, properties: dict[str, Any]) -> None:
        """Idempotently MERGE a node with the given label and properties."""
        ...

    @abstractmethod
    def merge_relationship(
        self,
        rel_type: str,
        from_id: str,
        to_id: str,
        properties: Optional[dict[str, Any]] = None,
    ) -> None:
        """Idempotently MERGE a relationship between two nodes."""
        ...

    @abstractmethod
    def get_entity(self, repo: str, identifier: str) -> Optional[dict[str, Any]]:
        """Find a code entity by ID, path, or name."""
        ...

    @abstractmethod
    def get_node(self, node_id: str) -> Optional[dict[str, Any]]:
        """Find any node by its id, whatever its label. None when it does not exist.

        Needed to answer "is this decision real?" without knowing in advance which
        label to look under.
        """
        ...

    @abstractmethod
    def search_entities(
        self, repo: str, query: str, limit: Optional[int] = None
    ) -> list[dict[str, Any]]:
        """Search code entities matching a substring or pattern."""
        ...

    @abstractmethod
    def get_decisions_for_entity(self, entity_id: str) -> list[dict[str, Any]]:
        """Fetch decisions governing an entity, including connected evidence."""
        ...

    @abstractmethod
    def search_decisions(
        self, repo: str, tokens: Sequence[str], limit: int = 5
    ) -> list[dict[str, Any]]:
        """Find a repository's decisions whose text mentions the given tokens.

        Ranked most-mentioned first. Used to answer a question that names no entity:
        the decisions are found from their own text and an entity is derived from them
        through GOVERNS.
        """
        ...

    @abstractmethod
    def get_entities_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        """The code entities a decision GOVERNS."""
        ...

    @abstractmethod
    def list_decisions(
        self,
        repo: str,
        entity_id: Optional[str] = None,
        state: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        """A repository's decisions, newest first, filtered and paged.

        Returns `{"items": [node, ...], "total": int}` where `total` counts every
        match before `limit`/`offset`. Each item carries an `entities` list of the
        code-entity ids the decision GOVERNS. Undated decisions sort last.
        """
        ...

    @abstractmethod
    def count_nodes(self, repo: str, label: str) -> int:
        """How many nodes of a label belong to a repository."""
        ...

    @abstractmethod
    def list_repositories(self) -> list[dict[str, Any]]:
        """Every repository in the graph, as its Repository node, ordered by id."""
        ...

    @abstractmethod
    def delete_repository(self, repo_ids: Sequence[str]) -> None:
        """Remove every node whose `repo` property is in `repo_ids`.

        A rebuild calls this before loading so stale nodes from earlier builds cannot
        survive. Both the API slug and the raw owner/name are passed while old graph
        rows may use either form.
        """
        ...

    @abstractmethod
    def get_subgraph(
        self,
        repo: str,
        entity_id: Optional[str] = None,
        node_cap: int = 80,
    ) -> dict[str, Any]:
        """Fetch a bounded subgraph containing nodes and edges for the UI."""
        ...

    @abstractmethod
    def node_count(self) -> int:
        """How many nodes are present, read back from the store rather than counted
        from the rows that were merged."""
        ...

    @abstractmethod
    def relationship_count(self) -> int:
        """How many relationships are present, read back from the store."""
        ...

    @abstractmethod
    def label_counts(self) -> dict[str, int]:
        """How many nodes carry each label, read back from the store."""
        ...

    @abstractmethod
    def relationship_type_counts(self) -> dict[str, int]:
        """How many relationships there are of each type, read back from the store."""
        ...

    def source_text_for(self, source_id: str) -> str:
        """The stored text a quote is re-verified against at answer time.

        Default is empty: a store without source text can still answer, it just
        cannot re-verify a quote. A real store overrides this with the node's text.
        """
        return ""

    def get_evidence_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        """The evidence nodes that support a decision, reached through SUPPORTED_BY.

        Default is empty: a store that does not model evidence reports none rather
        than inventing any. A real store returns the stored rows so a decision
        detail can carry the quotations behind it.
        """
        return []

    def index_states(self) -> dict[str, str]:
        """Name -> state for the indexes the store actually has.

        Read only, and empty by default: a store without indexes reports nothing
        rather than inventing a state. A real store reads the names and states
        back so the guided walkthrough can show whether the vector and full-text
        indexes exist instead of asserting that they do.
        """
        return {}

    def get_links_for_repo(self, repo: str) -> list[dict[str, Any]]:
        """Fetch relationship links for a repository."""
        return []

    def get_people_for_entity(self, repo: str, entity_id: str) -> list[dict[str, Any]]:
        """Fetch people associated with the repository / entity."""
        return []

    @abstractmethod
    def close(self) -> None:
        """Release underlying connections."""
        ...


# ---------------------------------------------------------------------------
# In-Memory Graph Store (For tests and local mode without live AuraDB)
# ---------------------------------------------------------------------------

class InMemoryGraphStore(BaseGraphStore):
    """Thread-safe in-memory graph store for testing and local development."""

    is_real: bool = False

    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.labels: dict[str, set[str]] = {}  # id -> set of labels
        # (from_id, rel_type, to_id) -> properties dict
        self.edges: dict[tuple[str, str, str], dict[str, Any]] = {}
        # source_id -> full stored text, so quotes can be verified at answer time
        self.source_texts: dict[str, str] = {}

    def source_text_for(self, source_id: str) -> str:
        if source_id in self.source_texts:
            return self.source_texts[source_id]
        # A build writes the corpus onto the source node rather than into the dict, so
        # fall back to the node's `text` before giving up.
        node = self.nodes.get(source_id)
        if node and node.get("text"):
            return str(node["text"])
        return ""

    def node_count(self) -> int:
        return len(self.nodes)

    def relationship_count(self) -> int:
        return len(self.edges)

    def label_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for labels in self.labels.values():
            for label in labels:
                counts[label] = counts.get(label, 0) + 1
        return dict(sorted(counts.items()))

    def relationship_type_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for (_from_id, rel_type, _to_id) in self.edges:
            counts[rel_type] = counts.get(rel_type, 0) + 1
        return dict(sorted(counts.items()))

    def count_nodes(self, repo: str, label: str) -> int:
        return sum(
            1
            for node_id, labels in self.labels.items()
            if label in labels and self.nodes.get(node_id, {}).get("repo") == repo
        )

    def list_repositories(self) -> list[dict[str, Any]]:
        nodes = [
            dict(self.nodes[node_id])
            for node_id, labels in self.labels.items()
            if "Repository" in labels
        ]
        return sorted(nodes, key=lambda node: str(node.get("id", "")))

    def delete_repository(self, repo_ids: Sequence[str]) -> None:
        wanted = set(repo_ids)
        stale = {
            node_id
            for node_id, properties in self.nodes.items()
            if properties.get("repo") in wanted
        }
        for node_id in stale:
            self.nodes.pop(node_id, None)
            self.labels.pop(node_id, None)
            self.source_texts.pop(node_id, None)
        for edge in [edge for edge in self.edges if edge[0] in stale or edge[2] in stale]:
            self.edges.pop(edge, None)

    def init_schema(self) -> None:
        # In-memory stores have implicit constraints
        pass

    def merge_node(self, label: str, properties: dict[str, Any]) -> None:
        _require_allowed(label, ALLOWED_NODE_LABELS, "node label")
        node_id = properties.get("id") or properties.get("login")
        if not node_id:
            raise ValueError(f"Node must have an 'id' or 'login' property: {properties}")
        node_id = str(node_id)
        if node_id not in self.nodes:
            self.nodes[node_id] = {}
            self.labels[node_id] = set()
        self.nodes[node_id].update(properties)
        self.labels[node_id].add(label)

    def merge_relationship(
        self,
        rel_type: str,
        from_id: str,
        to_id: str,
        properties: Optional[dict[str, Any]] = None,
    ) -> None:
        _require_allowed(rel_type, ALLOWED_REL_TYPES, "relationship type")
        if not isinstance(from_id, str) or not isinstance(to_id, str):
            raise TypeError("relationship endpoints must be strings, not mappings")
        key = (from_id, rel_type, to_id)
        if key not in self.edges:
            self.edges[key] = {}
        if properties:
            self.edges[key].update(properties)

    def get_node(self, node_id: str) -> Optional[dict[str, Any]]:
        return self.nodes.get(node_id)

    def get_entity(self, repo: str, identifier: str) -> Optional[dict[str, Any]]:
        clean_ident = identifier.strip().lower()
        for node_id, props in self.nodes.items():
            if "CodeEntity" not in self.labels.get(node_id, set()):
                continue
            if props.get("repo") != repo:
                continue
            if (
                node_id.lower() == clean_ident
                or props.get("name", "").lower() == clean_ident
                or props.get("path", "").lower() == clean_ident
            ):
                return props
        return None

    def search_entities(
        self, repo: str, query: str, limit: Optional[int] = None
    ) -> list[dict[str, Any]]:
        clean_q = query.strip().lower()
        results: list[dict[str, Any]] = []
        for node_id, props in self.nodes.items():
            if "CodeEntity" not in self.labels.get(node_id, set()):
                continue
            if props.get("repo") != repo:
                continue
            if (
                not clean_q
                or clean_q in props.get("name", "").lower()
                or clean_q in props.get("path", "").lower()
            ):
                results.append(props)
                if limit is not None and len(results) >= limit:
                    break
        return results

    def get_decisions_for_entity(self, entity_id: str) -> list[dict[str, Any]]:
        decisions: list[dict[str, Any]] = []
        for (f_id, r_type, t_id) in self.edges:
            if r_type == "GOVERNS" and t_id == str(entity_id):
                dec_props = dict(self.nodes.get(f_id, {}))
                # Gather evidence
                ev_list: list[dict[str, Any]] = []
                for (d_id, ev_rel, ev_id) in self.edges:
                    if d_id == f_id and ev_rel == "SUPPORTED_BY":
                        ev_props = self.nodes.get(ev_id)
                        if ev_props:
                            ev_list.append(ev_props)
                dec_props["evidence"] = ev_list
                decisions.append(dec_props)
        return decisions

    def search_decisions(
        self, repo: str, tokens: Sequence[str], limit: int = 5
    ) -> list[dict[str, Any]]:
        wanted = [t.lower() for t in tokens if t and t.strip()]
        if not wanted:
            return []
        scored: list[tuple[int, dict[str, Any]]] = []
        for node_id, props in self.nodes.items():
            if "Decision" not in self.labels.get(node_id, set()):
                continue
            if props.get("repo") != repo:
                continue
            blob = f"{props.get('summary', '')} {props.get('rationale') or ''}".lower()
            mentions = sum(1 for token in wanted if token in blob)
            for (d_id, rel, ev_id) in self.edges:
                if d_id == node_id and rel == "SUPPORTED_BY":
                    quote = str(self.nodes.get(ev_id, {}).get("quote", "")).lower()
                    mentions += sum(1 for token in wanted if token in quote)
            if mentions:
                scored.append((mentions, dict(props)))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [props for _, props in scored[:limit]]

    def get_entities_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        entities: list[dict[str, Any]] = []
        for (f_id, rel, t_id) in self.edges:
            if f_id == decision_id and rel == "GOVERNS":
                node = self.nodes.get(t_id)
                if node and "CodeEntity" in self.labels.get(t_id, set()):
                    entities.append(dict(node))
        return entities

    def get_evidence_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        evidence: list[dict[str, Any]] = []
        for (f_id, rel, t_id) in self.edges:
            if f_id == decision_id and rel == "SUPPORTED_BY":
                node = self.nodes.get(t_id)
                if node is not None and "Evidence" in self.labels.get(t_id, set()):
                    evidence.append(dict(node))
        return evidence

    def list_decisions(
        self,
        repo: str,
        entity_id: Optional[str] = None,
        state: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        for node_id, props in self.nodes.items():
            if "Decision" not in self.labels.get(node_id, set()):
                continue
            if props.get("repo") != repo:
                continue
            if state is not None and props.get("state") != state:
                continue
            entity_ids = [
                e.get("id") for e in self.get_entities_for_decision(node_id) if e.get("id")
            ]
            if entity_id is not None and entity_id not in entity_ids:
                continue
            items.append({**props, "entities": entity_ids})
        # Sort by id first so the newest-first sort (which is stable) leaves equal
        # dates in id order, then put undated decisions last.
        items.sort(key=lambda d: str(d.get("id", "")))
        items.sort(
            key=lambda d: (d.get("effective_at") is not None, d.get("effective_at") or ""),
            reverse=True,
        )
        return {"items": items[offset : offset + limit], "total": len(items)}

    def get_subgraph(
        self,
        repo: str,
        entity_id: Optional[str] = None,
        node_cap: int = 80,
    ) -> dict[str, Any]:
        node_ids: set[str] = set()
        if entity_id and entity_id in self.nodes:
            node_ids.add(entity_id)
            # Add 1-hop and 2-hop neighbors
            for (f, r, t) in self.edges:
                if f == entity_id or t == entity_id:
                    node_ids.add(f)
                    node_ids.add(t)
        else:
            # Gather one past the cap so "exactly at the cap, but more existed" is
            # distinguishable from "the graph is smaller than the cap".
            for n_id, props in self.nodes.items():
                if props.get("repo") == repo:
                    node_ids.add(n_id)
                if len(node_ids) > node_cap:
                    break

        truncated = len(node_ids) > node_cap
        selected_nodes = [
            {**self.nodes[n_id], "labels": list(self.labels.get(n_id, []))}
            for n_id in list(node_ids)[:node_cap]
            if n_id in self.nodes
        ]
        active_ids = {n["id"] for n in selected_nodes if "id" in n}

        selected_edges = [
            {"from": f, "to": t, "type": r, **props}
            for (f, r, t), props in self.edges.items()
            if f in active_ids and t in active_ids
        ]
        return {"nodes": selected_nodes, "relationships": selected_edges, "truncated": truncated}

    def get_links_for_repo(self, repo: str) -> list[dict[str, Any]]:
        res: list[dict[str, Any]] = []
        for (from_id, rel_type, to_id), props in self.edges.items():
            res.append({
                "source_id": from_id,
                "rel_type": rel_type,
                "target_id": to_id,
                **props,
            })
        return res

    def get_people_for_entity(self, repo: str, entity_id: str) -> list[dict[str, Any]]:
        people: list[dict[str, Any]] = []
        for node_id, labels in self.labels.items():
            if "Person" in labels:
                p = self.nodes.get(node_id)
                if p:
                    people.append(p)
        return people

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Real Neo4j Graph Store (AuraDB / Self-Hosted)
# ---------------------------------------------------------------------------

class Neo4jGraphStore(BaseGraphStore):
    """Production graph store backed by Neo4j driver and parameterized Cypher."""

    def __init__(
        self,
        uri: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        database: str = "neo4j",
        *,
        driver: Optional[Any] = None,
    ) -> None:
        # `driver` is an injectable seam: a test can pass a fake driver so the query
        # construction and record shaping are exercised without a live database.
        if driver is None:
            try:
                import neo4j
            except ImportError as exc:
                raise RuntimeError("neo4j package is required to connect to Neo4j AuraDB") from exc
            driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
        self.driver = driver
        self.database = database

    def init_schema(self) -> None:
        """Applies uniqueness constraints, indexes, vector index, and full-text index."""
        with self.driver.session(database=self.database) as session:
            for constraint_q in NODE_CONSTRAINTS:
                session.run(constraint_q)
            for index_q in NODE_INDEXES:
                session.run(index_q)
            created = 0
            try:
                session.run(VECTOR_INDEX_QUERY)
                created += 1
            except Exception as exc:
                # A missing vector index silently degrades retrieval, so it is raised.
                raise RuntimeError(
                    "the 384-dim cosine vector index could not be created; "
                    "check that this Neo4j version supports vector indexes"
                ) from exc
            try:
                session.run(FULLTEXT_INDEX_QUERY)
                created += 1
            except Exception as exc:
                raise RuntimeError(
                    "the evidence quote full-text index could not be created"
                ) from exc
            logger.info(
                "Schema applied: %d constraints, %d property indexes, %d specialised indexes.",
                len(NODE_CONSTRAINTS), len(NODE_INDEXES), created,
            )

    def merge_node(self, label: str, properties: dict[str, Any]) -> None:
        _require_allowed(label, ALLOWED_NODE_LABELS, "node label")
        node_id_field = "login" if label == "Person" else "id"
        query = (
            f"MERGE (n:{label} {{{node_id_field}: $props.{node_id_field}}}) "
            f"SET n += $props"
        )
        with self.driver.session(database=self.database) as session:
            session.run(query, props=properties)

    def merge_relationship(
        self,
        rel_type: str,
        from_id: str,
        to_id: str,
        properties: Optional[dict[str, Any]] = None,
    ) -> None:
        _require_allowed(rel_type, ALLOWED_REL_TYPES, "relationship type")
        if not isinstance(from_id, str) or not isinstance(to_id, str):
            raise TypeError("relationship endpoints must be strings, not mappings")
        query = (
            f"MATCH (a {{id: $from_id}}), (b {{id: $to_id}}) "
            f"MERGE (a)-[r:{rel_type}]->(b) "
            f"SET r += $props"
        )
        props = properties or {}
        with self.driver.session(database=self.database) as session:
            session.run(query, from_id=from_id, to_id=to_id, props=props)

    def get_node(self, node_id: str) -> Optional[dict[str, Any]]:
        """Fetch any node by id across labels.

        The label is not part of the lookup: a caller asking whether a decision
        exists should not have to know that decisions are stored as `Decision`.
        """
        query = "MATCH (n) WHERE n.id = $node_id OR n.login = $node_id RETURN n LIMIT 1"
        with self.driver.session(database=self.database) as session:
            rows = list(session.run(query, node_id=node_id))
        return dict(rows[0]["n"]) if rows else None

    def get_entity(self, repo: str, identifier: str) -> Optional[dict[str, Any]]:
        query = (
            "MATCH (e:CodeEntity {repo: $repo}) "
            "WHERE e.id = $ident OR toLower(e.name) = toLower($ident) OR toLower(e.path) = toLower($ident) "
            "RETURN e LIMIT 1"
        )
        with self.driver.session(database=self.database) as session:
            result = session.run(query, repo=repo, ident=identifier.strip())
            record = result.single()
            return dict(record["e"]) if record else None

    def search_entities(
        self, repo: str, query: str, limit: Optional[int] = None
    ) -> list[dict[str, Any]]:
        cql = (
            "MATCH (e:CodeEntity {repo: $repo}) "
            "WHERE toLower(e.name) CONTAINS toLower($q) OR toLower(e.path) CONTAINS toLower($q) "
            "RETURN e"
        )
        if limit is not None:
            cql += f" LIMIT {int(limit)}"
        with self.driver.session(database=self.database) as session:
            result = session.run(cql, repo=repo, q=query.strip())
            return [dict(record["e"]) for record in result]

    def get_decisions_for_entity(self, entity_id: str) -> list[dict[str, Any]]:
        with self.driver.session(database=self.database) as session:
            result = session.run(GET_DECISIONS_GOVERNING_ENTITY, entity_id=entity_id)
            items: list[dict[str, Any]] = []
            for record in result:
                d = dict(record["d"])
                d["evidence"] = [dict(ev) for ev in record.get("evidence", [])]
                d["sources"] = [dict(s) for s in record.get("sources", [])]
                items.append(d)
            return items

    def search_decisions(
        self, repo: str, tokens: Sequence[str], limit: int = 5
    ) -> list[dict[str, Any]]:
        clean = [t.strip() for t in tokens if t and t.strip()]
        if not clean:
            return []
        # Lucene treats punctuation as operators, so each token is reduced to its
        # word characters before it is OR-ed into the full-text query.
        terms = [re.sub(r"[^\w]+", "", token) for token in clean]
        terms = [term for term in terms if term]
        scores: dict[str, float] = {}
        rows: dict[str, dict[str, Any]] = {}
        with self.driver.session(database=self.database) as session:
            if terms:
                lucene = " OR ".join(terms)
                try:
                    for record in session.run(
                        SEARCH_DECISIONS_BY_TEXT,
                        q=lucene,
                        repo=repo,
                    ):
                        decision = dict(record["decision"])
                        rows[decision["id"]] = decision
                        scores[decision["id"]] = scores.get(decision["id"], 0.0) + float(
                            record["score"]
                        )
                except Exception as exc:  # noqa: BLE001 - fall back to substring matching
                    logger.warning("full-text decision search unavailable: %s", type(exc).__name__)
            for record in session.run(
                SEARCH_DECISIONS_BY_SUMMARY,
                repo=repo,
                tokens=clean,
            ):
                decision = dict(record["decision"])
                rows.setdefault(decision["id"], decision)
                scores[decision["id"]] = scores.get(decision["id"], 0.0) + 1.0
        ranked = sorted(rows.values(), key=lambda d: scores.get(d.get("id", ""), 0.0), reverse=True)
        return ranked[:limit]

    def get_entities_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        with self.driver.session(database=self.database) as session:
            result = session.run(GET_ENTITIES_FOR_DECISION, decision_id=decision_id)
            return [dict(record["e"]) for record in result]

    def get_evidence_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        query = (
            "MATCH (d:Decision {id: $decision_id})-[:SUPPORTED_BY]->(ev:Evidence) "
            "RETURN ev"
        )
        with self.driver.session(database=self.database) as session:
            return [dict(record["ev"]) for record in session.run(query, decision_id=decision_id)]

    def list_decisions(
        self,
        repo: str,
        entity_id: Optional[str] = None,
        state: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        params = {
            "repo": repo,
            "entity_id": entity_id,
            "state": state,
            "limit": limit,
            "offset": offset,
        }
        with self.driver.session(database=self.database) as session:
            total_record = session.run(COUNT_DECISIONS_FOR_REPOSITORY, **params).single()
            total = int(total_record["total"]) if total_record is not None else 0
            items: list[dict[str, Any]] = []
            for record in session.run(LIST_DECISIONS_FOR_REPOSITORY, **params):
                node = dict(record["d"])
                node["entities"] = list(record.get("entities") or [])
                items.append(node)
            return {"items": items, "total": total}

    def get_subgraph(
        self,
        repo: str,
        entity_id: Optional[str] = None,
        node_cap: int = 80,
    ) -> dict[str, Any]:
        with self.driver.session(database=self.database) as session:
            # Ask for one node past the cap: if it comes back, the graph held more than
            # the cap and the response is truncated. Without the extra node an exactly
            # full result is indistinguishable from a complete one.
            probe_cap = node_cap + 1
            if entity_id:
                result = session.run(
                    GET_SUBGRAPH_FOR_ENTITY,
                    entity_id=entity_id,
                    node_cap=probe_cap,
                )
            else:
                # Seeded from the repository's Decision nodes so the view is the
                # decisions and what they connect to, not an arbitrary page of nodes.
                result = session.run(
                    GET_SUBGRAPH_FOR_REPOSITORY,
                    repo=repo,
                    node_cap=probe_cap,
                )
            nodes: list[dict[str, Any]] = []
            seen: set[str] = set()
            for record in result:
                node = record.get("node")
                if node is None:
                    continue
                props = dict(node)
                props["labels"] = list(record.get("labels") or [])
                nid = props.get("id", props.get("login"))
                if nid is None or nid in seen:
                    continue
                seen.add(str(nid))
                nodes.append(props)

            truncated = len(nodes) > node_cap
            nodes = nodes[:node_cap]

            # Edges between the returned nodes. Without this the /graph endpoint
            # rendered an empty relationship list even when the graph had them. The
            # keys match what the in-memory store returns so the API reads one shape.
            relationships: list[dict[str, Any]] = []
            ids = [n.get("id") for n in nodes if n.get("id") is not None]
            if ids:
                edge_result = session.run(
                    "MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids "
                    "RETURN a.id AS `from`, type(r) AS `type`, b.id AS `to`, r AS props",
                    ids=ids,
                )
                for record in edge_result:
                    edge = {
                        "from": record["from"],
                        "type": record["type"],
                        "to": record["to"],
                    }
                    props = record.get("props")
                    if props:
                        edge.update(dict(props))
                    relationships.append(edge)
            return {"nodes": nodes, "relationships": relationships, "truncated": truncated}

    def node_count(self) -> int:
        with self.driver.session(database=self.database) as session:
            record = session.run("MATCH (n) RETURN count(n) AS c").single()
        return int(record["c"]) if record else 0

    def relationship_count(self) -> int:
        with self.driver.session(database=self.database) as session:
            record = session.run("MATCH ()-[r]->() RETURN count(r) AS c").single()
        return int(record["c"]) if record else 0

    def label_counts(self) -> dict[str, int]:
        with self.driver.session(database=self.database) as session:
            return {
                str(record["l"]): int(record["c"])
                for record in session.run(
                    "MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c ORDER BY l"
                )
            }

    def relationship_type_counts(self) -> dict[str, int]:
        with self.driver.session(database=self.database) as session:
            return {
                str(record["t"]): int(record["c"])
                for record in session.run(
                    "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c ORDER BY t"
                )
            }

    def count_nodes(self, repo: str, label: str) -> int:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", label):
            raise ValueError(f"unsafe node label: {label!r}")
        query = f"MATCH (n:`{label}` {{repo: $repo}}) RETURN count(n) AS c"
        with self.driver.session(database=self.database) as session:
            record = session.run(query, repo=repo).single()
        return int(record["c"]) if record else 0

    def list_repositories(self) -> list[dict[str, Any]]:
        query = "MATCH (r:Repository) RETURN r ORDER BY r.id"
        with self.driver.session(database=self.database) as session:
            return [dict(record["r"]) for record in session.run(query)]

    def delete_repository(self, repo_ids: Sequence[str]) -> None:
        if not repo_ids:
            return
        query = "MATCH (n) WHERE n.repo IN $repo_ids DETACH DELETE n"
        with self.driver.session(database=self.database) as session:
            session.run(query, repo_ids=list(repo_ids))

    def source_text_for(self, source_id: str) -> str:
        """The corpus stored on a source node, so a quote can be re-verified.

        The node id is the same cache id the evidence carries, so the lookup is by id.
        """
        query = "MATCH (n) WHERE n.id = $source_id RETURN n.text AS text LIMIT 1"
        with self.driver.session(database=self.database) as session:
            record = session.run(query, source_id=source_id).single()
        if record is None:
            return ""
        text = record.get("text")
        return str(text) if text else ""

    def index_states(self) -> dict[str, str]:
        """Read the index names and states back from the database."""
        query = "SHOW INDEXES YIELD name, state RETURN name, state ORDER BY name"
        with self.driver.session(database=self.database) as session:
            return {
                str(record["name"]): str(record["state"])
                for record in session.run(query)
            }

    def get_links_for_repo(self, repo: str) -> list[dict[str, Any]]:
        cql = (
            "MATCH (s)-[r]->(t) "
            "WHERE (s.repo = $repo OR t.repo = $repo) "
            "AND type(r) IN ['REVERTS', 'SUPERSEDES', 'PART_OF', 'REFERENCES', 'CONTAINS'] "
            "RETURN s.id AS source_id, type(r) AS rel_type, t.id AS target_id, properties(r) AS props"
        )
        with self.driver.session(database=self.database) as session:
            result = session.run(cql, repo=repo)
            items: list[dict[str, Any]] = []
            for record in result:
                item = {
                    "source_id": record["source_id"],
                    "rel_type": record["rel_type"],
                    "target_id": record["target_id"],
                }
                item.update(record.get("props") or {})
                items.append(item)
            return items

    def get_people_for_entity(self, repo: str, entity_id: str) -> list[dict[str, Any]]:
        cql = "MATCH (p:Person) RETURN properties(p) AS props LIMIT 100"
        with self.driver.session(database=self.database) as session:
            result = session.run(cql)
            return [dict(record["props"]) for record in result]

    def close(self) -> None:
        self.driver.close()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_graph_store(cfg: Optional[Settings] = None) -> BaseGraphStore:
    """Returns Neo4jGraphStore if credentials exist and reachable, otherwise InMemoryGraphStore."""
    config = cfg or settings
    if config.neo4j_uri and config.neo4j_username and config.neo4j_password:
        try:
            store = Neo4jGraphStore(
                uri=config.neo4j_uri,
                user=config.neo4j_username,
                password=config.neo4j_password,
                database=config.neo4j_database,
            )
            store.driver.verify_connectivity()
            return store
        except Exception as exc:
            logger.warning("Failed to connect to Neo4j (%s); falling back to InMemoryGraphStore", exc)
            if not config.allow_mock_providers and not config.sqlite_cache_path:
                raise
            return InMemoryGraphStore()
    return InMemoryGraphStore()

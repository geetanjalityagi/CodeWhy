import { useEffect, useRef, useState } from 'react';
import type { DecisionListItem, Entity, Repository } from '../types';
import {
  fetchRepositoryDecisionHistory,
  searchRepositoryEntities,
} from '../services/api';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileCode2,
  Loader2,
  Search,
} from 'lucide-react';

interface FileDecisionBriefViewProps {
  selectedRepo: Repository | null;
}

const EMPTY_DECISIONS: DecisionListItem[] = [];

function byDateAscending(a: DecisionListItem, b: DecisionListItem): number {
  if (!a.date || !b.date) {
    return a.date ? -1 : b.date ? 1 : a.id.localeCompare(b.id);
  }
  return Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id);
}

function byDateDescending(a: DecisionListItem, b: DecisionListItem): number {
  if (!a.date || !b.date) {
    return a.date ? -1 : b.date ? 1 : a.id.localeCompare(b.id);
  }
  return Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id);
}

function isExplicitRevert(decision: DecisionListItem): boolean {
  return /revert|rollback|roll back|rolled back|undo/i.test(
    `${decision.rule ?? ''} ${decision.summary}`,
  );
}

function deriveReadingOrder(decisions: DecisionListItem[]): DecisionListItem[] {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const remaining = new Set(byId.keys());
  const ordered: DecisionListItem[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((decision): decision is DecisionListItem =>
        Boolean(
          decision &&
            !decision.supersedes.some((priorId) => remaining.has(priorId)),
        ),
      )
      .sort(byDateAscending);
    const next = ready[0] ?? [...remaining]
      .map((id) => byId.get(id))
      .filter((decision): decision is DecisionListItem => Boolean(decision))
      .sort(byDateAscending)[0];

    if (!next) break;
    ordered.push(next);
    remaining.delete(next.id);
  }

  return ordered;
}

function DecisionItem({
  decision,
  note,
}: {
  decision: DecisionListItem;
  note?: string;
}) {
  return (
    <article className="rounded-xl border border-[#292A23] bg-[#12130F] p-4 shadow-sm hover:border-[#8C806F]/50 transition-all">
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-mono font-medium ${
                decision.state === 'ACTIVE'
                  ? 'border-[#2ea043]/30 bg-[#2ea043]/15 text-[#3fb950] status-badge-active'
                  : decision.state === 'REJECTED'
                    ? 'border-[#da3633]/30 bg-[#da3633]/15 text-[#f85149] status-badge-rejected'
                    : decision.state === 'SUPERSEDED'
                      ? 'border-[#8C806F]/40 bg-[#8C806F]/20 text-[#D4CBBF] status-badge-superseded'
                      : 'border-[#d29922]/30 bg-[#d29922]/15 text-[#e3b341] status-badge-unresolved'
              }`}
            >
              {decision.state}
            </span>
            <span className="text-[11px] font-mono text-[#A5A69D]">{decision.id}</span>
            <span className="text-[11px] font-mono text-[#8C806F]">
              {decision.date ? new Date(decision.date).toLocaleDateString() : 'date unknown'}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-[#F5F3ED]">{decision.summary}</p>
          {note && <p className="mt-1.5 text-xs font-mono text-[#A5A69D]">{note}</p>}
          {decision.supersedes.length > 0 && (
            <p className="mt-1.5 text-[11px] font-mono text-[#8C806F]">
              Supersedes: {decision.supersedes.join(', ')}
            </p>
          )}
        </div>
        {decision.source_url && (
          <a
            href={decision.source_url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open source for ${decision.id}`}
            className="shrink-0 rounded p-1 text-[#757F6C] hover:bg-[#181914] hover:text-[#AFD2FA] transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </article>
  );
}

function DecisionSection({
  title,
  description,
  decisions,
  emptyMessage,
  renderNote,
}: {
  title: string;
  description: string;
  decisions: DecisionListItem[];
  emptyMessage: string;
  renderNote?: (decision: DecisionListItem) => string | undefined;
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h2 className="text-sm font-semibold text-[#F5F3ED]">{title}</h2>
        <p className="mt-0.5 text-xs text-[#A5A69D]">{description}</p>
      </div>
      {decisions.length > 0 ? (
        <div className="space-y-2">
          {decisions.map((decision) => (
            <DecisionItem
              key={decision.id}
              decision={decision}
              note={renderNote?.(decision)}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-[#292A23] bg-[#12130F]/40 px-3.5 py-3 text-xs text-[#A5A69D]">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}

export function FileDecisionBriefView({ selectedRepo }: FileDecisionBriefViewProps) {
  const repoId = selectedRepo?.id ?? '';
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [searchingQuery, setSearchingQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [history, setHistory] = useState<DecisionListItem[] | null>(null);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyReload, setHistoryReload] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Monotonic token so a slow, older search can never overwrite a newer one.
  const searchSeqRef = useRef(0);

  useEffect(() => {
    const searchTerm = query.trim();
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;

    if (!repoId || !searchTerm) {
      setEntities([]);
      setSearchedQuery('');
      setSearchingQuery('');
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearchingQuery(searchTerm);
      try {
        const response = await searchRepositoryEntities(repoId, searchTerm);
        if (!cancelled && seq === searchSeqRef.current) {
          setEntities(response.entities.filter((entity) => entity.type === 'File'));
          setSearchError(null);
          setSearchedQuery(searchTerm);
        }
      } catch (error) {
        if (!cancelled && seq === searchSeqRef.current) {
          setEntities([]);
          setSearchError(error instanceof Error ? error.message : 'File search failed');
          setSearchedQuery(searchTerm);
        }
      } finally {
        if (!cancelled && seq === searchSeqRef.current) {
          setSearchingQuery((current) => current === searchTerm ? '' : current);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, repoId]);

  useEffect(() => {
    if (!repoId || !selectedEntity?.id) return;

    let cancelled = false;

    fetchRepositoryDecisionHistory(repoId)
      .then((response) => {
        if (!cancelled) {
          setHistory(response.items);
          setHistoryCount(response.total);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHistoryError(
            error instanceof Error ? error.message : 'Failed to load decision history',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, selectedEntity?.id, historyReload]);

  const allDecisions = history ?? EMPTY_DECISIONS;
  const linkedDecisions = selectedEntity
    ? allDecisions.filter((decision) => decision.entities.includes(selectedEntity.id))
    : [];
  const governingDecisions = linkedDecisions
    .filter((decision) => decision.state === 'ACTIVE')
    .sort(byDateDescending);
  const rejectedDecisions = linkedDecisions
    .filter((decision) => decision.state === 'REJECTED')
    .sort(byDateDescending);
  const revertedDecisions = linkedDecisions
    .filter((decision) => isExplicitRevert(decision))
    .sort(byDateDescending);
  const recentActiveDecisions = [...allDecisions]
    .filter((decision) => decision.state === 'ACTIVE')
    .sort(byDateDescending)
    .slice(0, 4);
  const readingOrder = deriveReadingOrder(linkedDecisions);
  const linkedDecisionIds = new Set(linkedDecisions.map((decision) => decision.id));

  return (
    <div className="h-[calc(100vh-4rem)] w-full overflow-y-auto bg-[#080907] text-[#F5F3ED]">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-[#292A23] bg-[#0B0C09] px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <FileCode2 className="h-4 w-4 text-[#B9915E]" />
          <div>
            <h1 className="text-sm font-semibold text-[#F5F3ED]">Before You Change This File</h1>
            <p className="text-[11px] font-mono text-[#A5A69D]">{selectedRepo?.name ?? repoId}</p>
          </div>
        </div>
        {selectedEntity && history && (
          <span className="text-xs font-mono text-[#A5A69D]">
            Derived from {linkedDecisions.length} decisions
          </span>
        )}
      </header>

      <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[#F5F3ED]">Find a file</h2>
            <p className="mt-1 text-xs text-[#A5A69D]">
              Search repository files by entity label to inspect their recorded decision history.
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#B9915E]" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files by name"
              aria-label="Search files by name"
              className="w-full rounded-lg border border-[#292A23] bg-[#12130F] py-2.5 pl-9 pr-3 text-sm font-mono text-[#F5F3ED] placeholder:text-[#A5A69D]/50 focus:border-[#B9915E]/70 focus:outline-none focus:ring-1 focus:ring-[#B9915E]/30 transition-all"
            />
          </div>
          {searchingQuery === query.trim() && query.trim() && (
            <p className="flex items-center gap-2 text-xs text-[#A5A69D]" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#757F6C]" />
              Searching files…
            </p>
          )}
          {searchedQuery === query.trim() && searchError && (
            <p className="rounded-xl border border-[#da3633]/40 bg-[#12130F] p-3 text-xs text-[#f85149]" role="alert">
              {searchError}
            </p>
          )}
          {searchedQuery === query.trim() && query.trim() && !searchError && entities.length === 0 && (
            <p className="text-xs text-[#A5A69D]">No matching files found.</p>
          )}
          {searchedQuery === query.trim() && entities.length > 0 && (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[#292A23] bg-[#0B0C09] p-1.5 shadow-lg">
              {entities.map((entity) => {
                const isSelected = selectedEntity?.id === entity.id;
                return (
                  <li key={entity.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedEntity?.id === entity.id) return;
                        setSelectedEntity(entity);
                        setHistory(null);
                        setHistoryCount(0);
                        setIsLoadingHistory(true);
                        setHistoryError(null);
                      }}
                      className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[#181914] text-[#F5F3ED] border border-[#B9915E]/40 shadow-sm'
                          : 'text-[#A5A69D] hover:bg-[#12130F] hover:text-[#F5F3ED] border border-transparent'
                      }`}
                    >
                      <FileCode2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-[#B9915E]' : 'text-[#757F6C]'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[#F5F3ED]">{entity.path || entity.label}</span>
                        <span className="block truncate text-[10px] font-mono text-[#A5A69D]">{entity.id}</span>
                      </span>
                      <span className="shrink-0 rounded border border-[#292A23] bg-[#12130F] px-1.5 py-0.5 text-[10px] font-mono text-[#A5A69D]">
                        {entity.decision_count ?? 0} linked
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selectedEntity && (
          <div className="space-y-5">
            <section className="rounded-xl border border-[#292A23] bg-[#12130F] p-4 shadow-sm space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-[#A5A69D] font-semibold">Selected file</p>
              <p className="mt-1 break-all text-sm font-medium text-[#F5F3ED] font-mono">
                {selectedEntity.path || selectedEntity.label}
              </p>
              <p className="mt-1 break-all text-[11px] font-mono text-[#757F6C]">{selectedEntity.id}</p>
            </section>

            <div className="flex items-start gap-2.5 rounded-xl border border-[#B9915E]/30 bg-[#12130F] p-3.5 text-xs leading-relaxed text-[#A5A69D] shadow-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B9915E]" />
              <p>
                A file-level view can include unrelated repository decisions. Only a decision whose
                <code className="mx-1 rounded bg-[#080907] border border-[#292A23] px-1.5 py-0.5 font-mono text-[#B9915E]">entities</code>
                list explicitly contains this file is treated as supported for it; recent repository
                decisions without that link are labeled as unlinked.
              </p>
            </div>

            {isLoadingHistory && (
              <p className="flex items-center gap-2 py-4 text-xs text-[#A5A69D]" role="status">
                <Loader2 className="h-4 w-4 animate-spin text-[#757F6C]" />
                Loading repository decision history…
              </p>
            )}
            {historyError && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#da3633]/40 bg-[#12130F] p-3 text-xs text-[#f85149]" role="alert">
                <p>{historyError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setHistoryError(null);
                    setIsLoadingHistory(true);
                    setHistoryReload((reload) => reload + 1);
                  }}
                  className="rounded-lg border border-[#da3633]/40 px-2.5 py-1 text-xs text-[#f85149] hover:bg-[#da3633]/15 transition-colors cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}
            {history && (
              <>
                <DecisionSection
                  title="Supported governing decisions"
                  description="Active decisions explicitly linked to this file by the API response."
                  decisions={governingDecisions}
                  emptyMessage="No active decision is explicitly linked to this file."
                />
                <DecisionSection
                  title="Reverted / rollback decisions"
                  description="Linked decisions whose rule or summary explicitly identifies a revert or rollback."
                  decisions={revertedDecisions}
                  emptyMessage="No linked decision explicitly identifies a revert or rollback."
                />
                <DecisionSection
                  title="Rejected decisions"
                  description="Rejected decisions explicitly linked to this file."
                  decisions={rejectedDecisions}
                  emptyMessage="No rejected decision is explicitly linked to this file."
                />
                <DecisionSection
                  title="Recent active decisions"
                  description="The four most recent active decisions in the repository; unlinked items are not file-level evidence."
                  decisions={recentActiveDecisions}
                  emptyMessage="No active decisions are available in repository history."
                  renderNote={(decision) =>
                    linkedDecisionIds.has(decision.id)
                      ? 'Explicitly linked to this file.'
                      : 'Repository decision; no direct link to this file.'
                  }
                />
                <DecisionSection
                  title="Suggested reading order"
                  description="Linked history ordered oldest-first, respecting explicit supersedes relationships where available."
                  decisions={readingOrder}
                  emptyMessage="No decision history is explicitly linked to this file."
                  renderNote={(decision) => {
                    const index = readingOrder.findIndex((item) => item.id === decision.id);
                    return `Read ${index + 1} of ${readingOrder.length}`;
                  }}
                />
                <p className="flex items-center gap-2 border-t border-[#292A23] pt-3 text-[11px] font-mono text-[#A5A69D]">
                  <Check className="h-3.5 w-3.5 text-[#3fb950]" />
                  Reading order is derived from {linkedDecisions.length} explicitly linked decisions
                  out of {historyCount} repository decisions.
                </p>
              </>
            )}
          </div>
        )}
        {!selectedEntity && !query.trim() && (
          <div className="rounded-xl border border-[#292A23] bg-[#12130F] p-8 text-center space-y-2 shadow-sm">
            <Search className="mx-auto h-5 w-5 text-[#B9915E]" />
            <p className="text-xs font-mono text-[#A5A69D]">Search and select a file to build its brief.</p>
          </div>
        )}
      </main>
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import type { DecisionDetail, DecisionState } from '../types';
import { fetchDecisionDetail } from '../services/api';
import {
  X,
  Check,
  ArrowRight,
  HelpCircle,
  ExternalLink,
  Calendar,
  Clock,
  GitPullRequest,
  AlertCircle,
  Copy,
  CheckCheck,
  ShieldAlert,
  Loader2,
  Tag,
  Users,
  GitCommit,
  MessageSquare,
  FileText,
  AlertTriangle,
  Layers,
} from 'lucide-react';

interface DecisionDrawerProps {
  decisionId: string | null;
  onClose: () => void;
  onSelectDecision?: (decisionId: string) => void;
  onSelectCitation?: (citationId: string) => void;
  linkedEntities?: string[];
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  );
}

export const DecisionDrawer: React.FC<DecisionDrawerProps> = ({
  decisionId,
  onClose,
  onSelectDecision,
  onSelectCitation,
  linkedEntities,
}) => {
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [citationFeedback, setCitationFeedback] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const isOpen = Boolean(decisionId);

  // Keep the latest onClose without re-running the fetch effect on parent renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const drawer = drawerRef.current;
    if (drawer) {
      const focusable = getFocusableElements(drawer);
      (focusable[0] ?? drawer).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = drawerRef.current;
      if (!node) return;

      const focusable = getFocusableElements(node);
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    setCopyState('idle');
    setCitationFeedback(null);
  }, [decisionId]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!decisionId) {
      setDetail(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);
    // Never show the previous decision while the requested one loads or fails.
    setDetail(null);

    fetchDecisionDetail(decisionId)
      .then((data) => {
        if (isMounted) {
          setDetail(data);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err?.message || 'Failed to load decision detail');
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [decisionId]);

  if (!decisionId) return null;

  const handleCopy = async () => {
    if (!detail) return;
    const textToCopy = `Decision ${detail.id} (${detail.state}): ${detail.summary}\nRationale: ${detail.rationale || 'N/A'}`;
    let nextState: 'copied' | 'failed' = 'copied';
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      nextState = 'failed';
    }
    setCopyState(nextState);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2500);
  };

  const handleCitationClick = (citationId: string) => {
    if (onSelectCitation) {
      onSelectCitation(citationId);
      return;
    }
    setCitationFeedback(
      'This view has no citation receipt panel. Open the source link to inspect the original evidence.',
    );
  };

  const renderStateBadge = (state: DecisionState) => {
    switch (state) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#2ea043]/15 text-[#3fb950] border border-[#2ea043]/30 status-badge-active">
            <Check className="w-3.5 h-3.5 text-[#3fb950] stroke-[2.5] status-icon-active" />
            Active
          </span>
        );
      case 'SUPERSEDED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#8C806F]/20 text-[#D4CBBF] border border-[#8C806F]/40 status-badge-superseded">
            <ArrowRight className="w-3.5 h-3.5 text-[#D4CBBF] status-icon-superseded" />
            Superseded
          </span>
        );
      case 'REJECTED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#da3633]/15 text-[#f85149] border border-[#da3633]/30 status-badge-rejected">
            <X className="w-3.5 h-3.5 text-[#f85149] stroke-[2.5] status-icon-rejected" />
            Rejected
          </span>
        );
      case 'UNRESOLVED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#d29922]/15 text-[#e3b341] border border-[#d29922]/30 status-badge-unresolved">
            <HelpCircle className="w-3.5 h-3.5 text-[#e3b341] status-icon-unresolved" />
            Needs Review
          </span>
        );
    }
  };

  const authors = detail?.citations
    ? Array.from(new Set(detail.citations.map((c) => c.author).filter((a): a is string => Boolean(a))))
    : [];

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Container */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-drawer-title"
        tabIndex={-1}
        className="relative w-full max-w-lg bg-[#0B0C09] border-l border-[#292A23] h-full shadow-2xl flex flex-col z-10 text-[#F5F3ED]"
      >
        {/* Header */}
        <div className="sticky top-0 z-20 p-4 border-b border-[#292A23] flex items-center justify-between bg-[#0B0C09]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-[#12130F] text-[#B9915E] border border-[#292A23]">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span id="decision-drawer-title" className="font-mono text-sm font-semibold text-[#F5F3ED]">
                  Decision {decisionId}
                </span>
                {detail && renderStateBadge(detail.state)}
              </div>
              <span className="text-[11px] font-mono text-[#A5A69D]">
                Provenance Record
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span role="status" aria-live="polite" className="text-[10px] font-mono">
              {copyState === 'copied' && <span className="text-[#3fb950]">Copied</span>}
              {copyState === 'failed' && <span className="text-[#f85149]">Copy failed</span>}
            </span>
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg bg-[#12130F] hover:bg-[#181914] text-[#A5A69D] hover:text-[#F5F3ED] border border-[#292A23] transition-colors cursor-pointer"
              title={
                copyState === 'failed'
                  ? 'Copy failed — clipboard access was blocked'
                  : copyState === 'copied'
                    ? 'Decision summary copied'
                    : 'Copy decision summary'
              }
              aria-label={
                copyState === 'failed'
                  ? 'Copy failed'
                  : copyState === 'copied'
                    ? 'Decision summary copied'
                    : 'Copy decision summary'
              }
            >
              {copyState === 'copied' ? (
                <CheckCheck className="w-4 h-4 text-[#3fb950]" />
              ) : copyState === 'failed' ? (
                <AlertCircle className="w-4 h-4 text-[#f85149]" />
              ) : (
                <Copy className="w-4 h-4 text-[#A5A69D]" />
              )}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-[#12130F] hover:bg-[#181914] text-[#A5A69D] hover:text-[#F5F3ED] border border-[#292A23] transition-colors cursor-pointer"
              title="Close drawer (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isLoading && (
            <div className="py-16 flex flex-col items-center justify-center text-[#A5A69D] gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-[#757F6C]" />
              <p className="text-xs font-mono">Loading decision record...</p>
            </div>
          )}

          {error && (
            <div className="p-3.5 rounded-xl bg-[#12130F] border border-[#da3633]/40 text-[#f85149] space-y-1">
              <div className="flex items-center gap-2 font-medium text-xs">
                <AlertCircle className="w-4 h-4 text-[#f85149]" />
                <span>Failed to load decision</span>
              </div>
              <p className="text-xs font-mono text-[#A5A69D]">{error}</p>
            </div>
          )}

          {detail && !isLoading && (
            <>
              {/* Summary */}
              <div className="space-y-1.5">
                <h3 className="text-xs font-mono uppercase tracking-wider text-[#A5A69D]">
                  Summary
                </h3>
                <p className="text-sm font-medium text-[#F5F3ED] leading-relaxed bg-[#12130F] p-3 rounded-xl border border-[#292A23]">
                  {detail.summary}
                </p>
              </div>

              {/* Rationale */}
              <div className="space-y-1.5">
                <h3 className="text-xs font-mono uppercase tracking-wider text-[#A5A69D]">
                  Rationale
                </h3>
                {detail.rationale ? (
                  <div className="quote-text p-3 rounded-xl bg-[#080907] border border-[#292A23] text-[#F5F3ED] leading-relaxed border-l-2 border-l-[#757F6C]">
                    "{detail.rationale}"
                  </div>
                ) : (
                  <div className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] text-[#A5A69D] text-xs italic">
                    No explicit quoted rationale recorded in the source artifact.
                  </div>
                )}
              </div>

              {/* Linked Entities */}
              {linkedEntities && linkedEntities.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-mono uppercase tracking-wider text-[#A5A69D] flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-[#B9915E]" />
                    Linked Code Entities ({linkedEntities.length})
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {linkedEntities.map((ent) => {
                      const colon = ent.lastIndexOf(':');
                      const label = colon >= 0 && colon < ent.length - 1 ? ent.slice(colon + 1) : ent;
                      return (
                        <span
                          key={ent}
                          className="px-2 py-0.5 rounded bg-[#080907] border border-[#292A23] text-[#757F6C] font-mono text-xs"
                        >
                          {label}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Authors */}
              {authors.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-mono uppercase tracking-wider text-[#A5A69D] flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-[#B9915E]" />
                    Recorded Authors ({authors.length})
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {authors.map((author) => (
                      <span
                        key={author}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#080907] border border-[#292A23] text-xs font-mono text-[#A5A69D]"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[#2ea043]" />
                        @{author}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Source Reference & Rule */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] space-y-1">
                  <span className="text-[10px] font-mono text-[#A5A69D] uppercase">
                    Source Artifact
                  </span>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-medium text-[#F5F3ED] flex items-center gap-1.5">
                      {detail.source.type === 'Commit' ? (
                        <GitCommit className="w-3.5 h-3.5 text-[#8C806F]" />
                      ) : detail.source.type === 'Issue' ? (
                        <MessageSquare className="w-3.5 h-3.5 text-[#8C806F]" />
                      ) : detail.source.type === 'Document' ? (
                        <FileText className="w-3.5 h-3.5 text-[#8C806F]" />
                      ) : (
                        <GitPullRequest className="w-3.5 h-3.5 text-[#B9915E]" />
                      )}
                      {detail.source.type} {detail.source.number ? `#${detail.source.number}` : ''}
                    </span>
                    {detail.source.url && (
                      <a
                        href={detail.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-[#757F6C] hover:text-[#AFD2FA] hover:underline"
                        title="Open Source Link"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] space-y-1">
                  <span className="text-[10px] font-mono text-[#A5A69D] uppercase">
                    Supersession Rule
                  </span>
                  <div className="text-xs font-mono font-medium text-[#F5F3ED] truncate">
                    {detail.rule ? detail.rule : 'Direct ingest'}
                  </div>
                </div>
              </div>

              {/* Temporal Timeline */}
              <div className="p-3.5 rounded-xl bg-[#12130F] border border-[#292A23] space-y-1.5">
                <span className="text-[10px] font-mono text-[#A5A69D] uppercase tracking-wider block">
                  Temporal Timeline
                </span>
                <div className="space-y-1.5 text-xs font-mono">
                  <div className="flex items-center justify-between text-[#F5F3ED]">
                    <span className="text-[#A5A69D] flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-[#2ea043]" /> Effective:
                    </span>
                    <span>{detail.effective_at ? new Date(detail.effective_at).toLocaleDateString() : 'date unknown'}</span>
                  </div>
                  {detail.recorded_at && (
                    <div className="flex items-center justify-between text-[#F5F3ED]">
                      <span className="text-[#A5A69D] flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-[#8C806F]" /> Recorded:
                      </span>
                      <span>{new Date(detail.recorded_at).toLocaleDateString()}</span>
                    </div>
                  )}
                  {detail.ended_at && (
                    <div className="flex items-center justify-between text-[#f85149]">
                      <span className="text-[#A5A69D] flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-[#da3633]" /> Ended:
                      </span>
                      <span>{new Date(detail.ended_at).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Supersession Relationships */}
              <div className="space-y-2">
                <h3 className="text-xs font-mono uppercase tracking-wider text-[#A5A69D]">
                  Supersession Lineage
                </h3>

                <div className="p-3 rounded-xl bg-[#12130F] border border-[#B9915E]/30 text-[11px] font-mono text-[#A5A69D] flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-[#B9915E] shrink-0 mt-0.5" />
                  <span>
                    Supersession is corroborated by actual state and lineage rules rather than timestamps alone.
                  </span>
                </div>

                <div className="space-y-1.5">
                  {detail.supersedes && detail.supersedes.length > 0 && (
                    <div className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] text-xs font-mono flex items-center justify-between">
                      <span className="text-[#A5A69D]">Supersedes:</span>
                      <div className="flex flex-wrap gap-1.5">
                        {detail.supersedes.map((id) => (
                          <button
                            key={id}
                            onClick={() => onSelectDecision?.(id)}
                            className="px-2 py-0.5 rounded bg-[#080907] hover:bg-[#181914] text-[#757F6C] hover:text-[#AFD2FA] border border-[#292A23] transition-colors cursor-pointer"
                          >
                            {id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {detail.superseded_by && detail.superseded_by.length > 0 && (
                    <div className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] text-xs font-mono flex items-center justify-between">
                      <span className="text-[#A5A69D]">Superseded by:</span>
                      <div className="flex flex-wrap gap-1.5">
                        {detail.superseded_by.map((id) => (
                          <button
                            key={id}
                            onClick={() => onSelectDecision?.(id)}
                            className="px-2 py-0.5 rounded bg-[#080907] hover:bg-[#181914] text-[#B9915E] hover:text-[#AFD2FA] border border-[#292A23] transition-colors cursor-pointer"
                          >
                            {id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Citations Attached */}
              {detail.citations && detail.citations.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-mono uppercase tracking-wider text-[#A5A69D]">
                    Direct Verified Evidence ({detail.citations.length})
                  </h3>
                  <div className="space-y-2">
                    {citationFeedback && (
                      <div
                        role="status"
                        className="rounded-lg border border-[#292A23] bg-[#080907] px-3 py-2 text-[11px] font-mono text-[#A5A69D]"
                      >
                        {citationFeedback}
                      </div>
                    )}
                    {detail.citations.map((c) => (
                      <div
                        key={c.id}
                        data-testid={`decision-citation-${c.id}`}
                        role={onSelectCitation ? 'button' : undefined}
                        tabIndex={onSelectCitation ? 0 : undefined}
                        onClick={() => handleCitationClick(c.id)}
                        onKeyDown={
                          onSelectCitation
                            ? (event) => {
                                if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                                  event.preventDefault();
                                  handleCitationClick(c.id);
                                }
                              }
                            : undefined
                        }
                        className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] hover:border-[#8C806F]/50 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9915E]"
                      >
                        <div className="flex items-center justify-between text-[11px] font-mono text-[#A5A69D] mb-1">
                          <span className="text-[#757F6C] font-medium">{c.source_type}</span>
                          <span>{c.author ? `@${c.author}` : 'Anonymous'}</span>
                        </div>
                        <p className="quote-text text-xs text-[#F5F3ED] leading-relaxed border-l-2 border-[#757F6C] pl-2.5">
                          "{c.quote}"
                        </p>
                        {c.source_url && (
                          <div className="mt-2 text-right">
                            <a
                              href={c.source_url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-[11px] font-mono text-[#757F6C] hover:text-[#AFD2FA] hover:underline"
                            >
                              <span>View Source</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Evidence Gaps */}
              {detail.evidence_gaps && detail.evidence_gaps.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-mono uppercase tracking-wider text-[#d29922] flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    Evidence Gaps ({detail.evidence_gaps.length})
                  </h3>
                  <ul className="space-y-1 bg-[#12130F] border border-[#d29922]/30 p-2.5 rounded-xl text-xs text-[#e3b341] font-mono">
                    {detail.evidence_gaps.map((gap, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-[#d29922]">•</span>
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

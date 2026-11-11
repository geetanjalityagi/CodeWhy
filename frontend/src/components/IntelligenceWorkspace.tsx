import React, { useState, useEffect, useRef } from 'react';
import type {
  Repository,
  AskResponse,
} from '../types';
import {
  askQuestion,
  GROUNDED_DEMO_QUESTIONS,
} from '../services/api';
import { ContextualEvidenceMargin } from './ContextualEvidenceMargin';
import { DecisionDrawer } from './DecisionDrawer';
import {
  Send,
  Search,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Quote,
  Loader2,
  Copy,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  GitBranch,
  HelpCircle,
  XCircle,
  ArrowRight,
  Terminal,
  Sparkles,
  AlertCircle,
} from 'lucide-react';

interface IntelligenceWorkspaceProps {
  selectedRepo: Repository | null;
  onQuestionAnswered: (question: string, response: AskResponse) => void;
  initialQuestion?: string;
}

export const IntelligenceWorkspace: React.FC<IntelligenceWorkspaceProps> = ({
  selectedRepo,
  onQuestionAnswered,
  initialQuestion,
}) => {
  const [question, setQuestion] = useState(initialQuestion || '');
  const [entityId, setEntityId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);
  const [showConfidenceSignals, setShowConfidenceSignals] = useState(false);
  const [copiedAnswer, setCopiedAnswer] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isSuggestionsExpanded, setIsSuggestionsExpanded] = useState(false);

  const answerScrollRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const inFlightRef = useRef(false);
  const repoId = selectedRepo?.id || '';
  const repoIdRef = useRef(repoId);

  useEffect(() => {
    repoIdRef.current = repoId;
  }, [repoId]);

  // Switching repositories invalidates every displayed or pending answer.
  useEffect(() => {
    requestSeq.current += 1;
    inFlightRef.current = false;
    setIsLoading(false);
    setResponse(null);
    setError(null);
    setEntityId('');
    setSelectedDecisionId(null);
    setSelectedCitationId(null);
  }, [repoId]);

  const isDemoRepo = selectedRepo?.fixture ?? false;
  const groundedQuestions = (selectedRepo && GROUNDED_DEMO_QUESTIONS[selectedRepo.id]) || [];

  useEffect(() => {
    if (initialQuestion && initialQuestion.trim()) {
      setQuestion(initialQuestion);
      handleAsk(initialQuestion);
    }
  }, [initialQuestion]);

  useEffect(() => {
    if (response || error) {
      if (typeof answerScrollRef.current?.scrollTo === 'function') {
        answerScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }, [response, error]);

  const handleAsk = async (qText?: string, entId?: string) => {
    const qToAsk = (qText ?? question).trim();
    if (!qToAsk || qToAsk.length < 3) return;
    if (!repoId) {
      setError('Please select a repository to investigate.');
      return;
    }
    if (inFlightRef.current) return;

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const requestRepoId = repoId;
    const entityIdToSend = (entId !== undefined ? entId : entityId).trim() || undefined;
    inFlightRef.current = true;

    setIsLoading(true);
    setError(null);
    setSelectedCitationId(null);

    try {
      const res = await askQuestion(requestRepoId, {
        question: qToAsk,
        entity_id: entityIdToSend,
      });
      // Drop the answer if another request started or the repository changed.
      if (seq !== requestSeq.current || requestRepoId !== repoIdRef.current) return;
      setResponse(res);
      setQuestion(qToAsk);
      onQuestionAnswered(qToAsk, res);
    } catch (err: unknown) {
      if (seq !== requestSeq.current || requestRepoId !== repoIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to query the decision archeology engine';
      setError(message);
      setResponse(null);
    } finally {
      if (seq === requestSeq.current) {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    }
  };

  const handleCopyAnswer = async () => {
    if (!response?.answer) return;
    let nextState: 'copied' | 'failed' = 'copied';
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(response.answer);
    } catch {
      nextState = 'failed';
    }
    setCopiedAnswer(nextState);
    window.setTimeout(() => setCopiedAnswer('idle'), 2500);
  };

  const handleSelectCitation = (citId: string | null) => {
    setSelectedCitationId(citId);
    if (citId) {
      const elem = document.getElementById(`receipt-${citId}`);
      if (elem) {
        elem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  };

  const activeCitations = response?.citations || [];
  const activeEvidenceGaps = response?.evidence_gaps || [];
  const activeWhoToAsk = response?.who_to_ask || [];

  const renderAnswerWithCitations = (answerText: string) => {
    if (!activeCitations || activeCitations.length === 0) {
      return <p className="prose-answer text-[#F5F3ED] text-sm leading-relaxed">{answerText}</p>;
    }

    return (
      <div className="text-[#F5F3ED] leading-relaxed space-y-3">
        <p className="prose-answer text-sm leading-relaxed">{answerText}</p>
        <div className="pt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-mono text-[#A5A69D] uppercase tracking-wider mr-1">
            Citations:
          </span>
          {activeCitations.map((c, index) => {
            const isSelected = selectedCitationId === c.id;
            return (
              <button
                key={c.id}
                onClick={() => handleSelectCitation(isSelected ? null : c.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono font-medium transition-colors cursor-pointer border ${
                  isSelected
                    ? 'bg-[#757F6C] text-[#080907] border-[#8A9680]'
                    : 'bg-[#080907] text-[#B9915E] border-[#292A23] hover:border-[#B9915E]/50 hover:bg-[#181914]'
                }`}
                title={`View receipt: ${c.quote.slice(0, 50)}...`}
              >
                <Quote className="w-3 h-3" />
                <span>[{index + 1}: {c.id}]</span>
                {c.author && <span className="text-[10px] opacity-75">@{c.author}</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const showEvidencePanel = Boolean(response) || activeCitations.length > 0 || activeEvidenceGaps.length > 0;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] w-full bg-[#080907]">
      {/* Top context bar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2.5 border-b border-[#292A23] bg-[#0B0C09]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-[#A5A69D]">
            Investigation Target:
          </span>
          <span className="font-mono text-xs font-semibold text-[#F5F3ED] bg-[#12130F] px-2.5 py-1 rounded-md border border-[#292A23] flex items-center gap-1.5">
            <GitBranch className="w-3.5 h-3.5 text-[#757F6C]" />
            {selectedRepo?.name || repoId || 'No repository selected'}
          </span>
          {isDemoRepo && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#B9915E]/15 text-[#B9915E] border border-[#B9915E]/30">
              fixture
            </span>
          )}
          {selectedRepo?.last_rebuilt_at && (
            <span className="text-[11px] font-mono text-[#A5A69D] bg-[#12130F] px-2.5 py-1 rounded-md border border-[#292A23]">
              Last graph rebuild: {new Date(selectedRepo.last_rebuilt_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {/* Answer + evidence */}
      <div
        ref={answerScrollRef}
        className="flex-1 min-h-0 overflow-y-auto flex flex-col lg:flex-row"
      >
        <main className="flex-1 min-w-0 p-4 sm:p-6 space-y-4">
          {isLoading && (
            <div className="workbench-card rounded-xl bg-[#12130F] border border-[#292A23] p-8 text-center space-y-3">
              <div className="w-10 h-10 rounded-full bg-[#080907] border border-[#292A23] flex items-center justify-center mx-auto text-[#757F6C]">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
              <div>
                <h3 className="text-xs font-mono font-semibold text-[#F5F3ED]">
                  Querying Decision Graph & Verifying Quotes...
                </h3>
                <p className="text-[11px] font-mono text-[#A5A69D] mt-1">
                  Resolving entities, validating verbatim substring citations, and scoring provenance.
                </p>
              </div>
            </div>
          )}

          {error && (
            <div data-testid="backend-error-state" className="workbench-card rounded-xl bg-[#12130F] border border-[#da3633]/40 p-5 text-[#f85149] space-y-3">
              <div className="flex items-center gap-2 font-medium text-xs">
                <AlertTriangle className="w-4 h-4 text-[#f85149]" />
                <span>Backend Error</span>
              </div>
              <p className="text-xs font-mono text-[#A5A69D]">{error}</p>
              <button
                type="button"
                onClick={() => handleAsk()}
                className="px-3.5 py-1.5 rounded-md bg-[#080907] hover:bg-[#181914] text-[#F5F3ED] border border-[#292A23] text-xs font-mono transition-colors cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading && !error && !response && (
            <div className="workbench-card rounded-xl bg-[#12130F] border border-[#292A23] p-9 text-center space-y-4">
              <div className="w-10 h-10 rounded-lg bg-[#080907] text-[#B9915E] border border-[#292A23] flex items-center justify-center mx-auto">
                <Terminal className="w-5 h-5" />
              </div>
              <div className="max-w-md mx-auto space-y-1.5">
                <h3 className="text-sm font-semibold text-[#F5F3ED]">
                  Decision Investigation Console
                </h3>
                <p className="text-xs text-[#A5A69D] leading-relaxed">
                  Enter a question below to reconstruct historical engineering intent from Git commits, PRs, and review discussions.
                </p>
              </div>
            </div>
          )}

          {!isLoading && response && (
            <div className="space-y-4">
              {/* Full Verified Answer */}
              {response.outcome === 'full' && (
                <div className="workbench-card rounded-xl bg-[#12130F] border border-[#2ea043]/40 p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#292A23] pb-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono font-semibold bg-[#2ea043]/15 text-[#3fb950] border border-[#2ea043]/40">
                        <CheckCircle2 className="w-3.5 h-3.5 text-[#3fb950]" />
                        Full Verified Answer
                      </span>
                      {response.confidence && (
                        <span className="px-2.5 py-0.5 rounded-md text-xs font-mono font-medium bg-[#080907] text-[#757F6C] border border-[#292A23]">
                          {Math.round(response.confidence.score * 100)}% {response.confidence.label} Confidence
                        </span>
                      )}
                    </div>
                    <button
                      onClick={handleCopyAnswer}
                      className="px-2.5 py-1 rounded-md bg-[#080907] hover:bg-[#181914] border border-[#292A23] text-[#A5A69D] hover:text-[#F5F3ED] transition-colors flex items-center gap-1.5 text-xs font-mono cursor-pointer"
                      title={copiedAnswer === 'failed' ? 'Copy failed — clipboard access was blocked' : 'Copy answer text'}
                      aria-label={copiedAnswer === 'failed' ? 'Copy failed' : 'Copy answer text'}
                    >
                      {copiedAnswer === 'copied' ? (
                        <CheckCheck className="w-3.5 h-3.5 text-[#3fb950]" />
                      ) : copiedAnswer === 'failed' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-[#f85149]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span aria-live="polite">
                        {copiedAnswer === 'copied' ? 'Copied' : copiedAnswer === 'failed' ? 'Copy failed' : 'Copy'}
                      </span>
                    </button>
                  </div>

                  {response.entity && (
                    <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#080907] border border-[#292A23] text-xs font-mono">
                      <span className="text-[#757F6C] font-medium">{response.entity.type}:</span>
                      <span className="text-[#F5F3ED] font-semibold">{response.entity.label}</span>
                      {response.entity.path && (
                        <span className="text-[#A5A69D]">({response.entity.path})</span>
                      )}
                      <span className="text-[#A5A69D]/70">
                        • {response.entity.decision_count} governing decisions
                      </span>
                    </div>
                  )}

                  {response.answer && renderAnswerWithCitations(response.answer)}

                  <div className="flex items-center gap-2 pt-2 border-t border-[#292A23] text-xs font-mono">
                    <span className="text-[#A5A69D]">Real Outcome:</span>
                    <span className="font-bold uppercase text-[#2ea043]">{response.outcome}</span>
                  </div>
                </div>
              )}

              {/* Partial Answer */}
              {response.outcome === 'partial' && (
                <div className="workbench-card rounded-xl bg-[#12130F] border border-[#d29922]/40 p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#292A23] pb-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono font-semibold bg-[#d29922]/15 text-[#e3b341] border border-[#d29922]/40">
                        <HelpCircle className="w-3.5 h-3.5 text-[#e3b341]" />
                        Partial Answer
                      </span>
                      {response.reason_code && (
                        <span className="px-2.5 py-0.5 rounded-md text-xs font-mono bg-[#080907] text-[#e3b341] border border-[#292A23]">
                          Reason: {response.reason_code}
                        </span>
                      )}
                      {response.confidence && (
                        <span className="px-2.5 py-0.5 rounded-md text-xs font-mono text-[#A5A69D] bg-[#080907] border border-[#292A23]">
                          {Math.round(response.confidence.score * 100)}% {response.confidence.label}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={handleCopyAnswer}
                      className="px-2.5 py-1 rounded-md bg-[#080907] hover:bg-[#181914] border border-[#292A23] text-[#A5A69D] hover:text-[#F5F3ED] transition-colors flex items-center gap-1.5 text-xs font-mono cursor-pointer"
                      title={copiedAnswer === 'failed' ? 'Copy failed — clipboard access was blocked' : 'Copy answer text'}
                      aria-label={copiedAnswer === 'failed' ? 'Copy failed' : 'Copy answer text'}
                    >
                      {copiedAnswer === 'copied' ? (
                        <CheckCheck className="w-3.5 h-3.5 text-[#3fb950]" />
                      ) : copiedAnswer === 'failed' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-[#f85149]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span aria-live="polite">
                        {copiedAnswer === 'copied' ? 'Copied' : copiedAnswer === 'failed' ? 'Copy failed' : 'Copy'}
                      </span>
                    </button>
                  </div>

                  {response.answer && renderAnswerWithCitations(response.answer)}

                  <div className="flex items-center gap-2 pt-2 border-t border-[#292A23] text-xs font-mono">
                    <span className="text-[#A5A69D]">Real Outcome:</span>
                    <span className="font-bold uppercase text-[#e3b341]">{response.outcome}</span>
                    {response.reason_code && (
                      <span className="text-[#A5A69D]">({response.reason_code})</span>
                    )}
                  </div>

                  <div className="p-3 rounded-lg bg-[#080907] border border-[#d29922]/30 space-y-1">
                    <span className="text-xs font-mono font-medium text-[#e3b341] flex items-center gap-1.5 uppercase">
                      <AlertTriangle className="w-3.5 h-3.5 text-[#e3b341]" />
                      Missing Verbatim Rationale
                    </span>
                    <p className="text-xs font-mono text-[#A5A69D] leading-relaxed">
                      Code modifications were discovered, but no character-verified quote survived verification. See evidence gaps in the right margin.
                    </p>
                  </div>
                </div>
              )}

              {/* Refusal (Honest Negative) */}
              {response.outcome === 'refusal' && response.reason_code !== 'ambiguous_entity' && (
                <div className="workbench-card rounded-xl bg-[#12130F] border border-[#8C806F]/40 p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#292A23] pb-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono font-semibold bg-[#8C806F]/20 text-[#D4CBBF] border border-[#8C806F]/40">
                        <XCircle className="w-3.5 h-3.5 text-[#D4CBBF]" />
                        Principled Refusal
                      </span>
                      {response.reason_code && (
                        <span className="px-2.5 py-0.5 rounded-md text-xs font-mono bg-[#080907] text-[#D4CBBF] border border-[#292A23]">
                          Code: {response.reason_code}
                        </span>
                      )}
                    </div>
                  </div>

                  {response.answer && (
                    <p className="text-[#F5F3ED] text-sm leading-relaxed font-sans">
                      {response.answer}
                    </p>
                  )}

                  <div className="flex items-center gap-2 pt-2 border-t border-[#292A23] text-xs font-mono">
                    <span className="text-[#A5A69D]">Real Outcome:</span>
                    <span className="font-bold uppercase text-[#D4CBBF]">{response.outcome}</span>
                    {response.reason_code && (
                      <span className="px-2 py-0.5 rounded-md bg-[#080907] text-[#D4CBBF] border border-[#292A23]">
                        {response.reason_code}
                      </span>
                    )}
                  </div>

                  <div className="p-3.5 rounded-lg bg-[#080907] border border-[#292A23] text-xs font-mono text-[#A5A69D] space-y-1">
                    <span className="text-[#B9915E] font-medium block">
                      Refusal Guarantee:
                    </span>
                    <span className="leading-relaxed">
                      Refusal guarantees that CodeWhy never invents speculative reasons or fabricates historical records.
                    </span>
                  </div>
                </div>
              )}

              {/* Ambiguous Entity Disambiguation */}
              {response.outcome === 'refusal' && response.reason_code === 'ambiguous_entity' && (
                <div className="rounded-xl bg-[#12130F] border border-[#757F6C]/40 p-5 space-y-4">
                  <div className="flex items-center gap-2 border-b border-[#292A23] pb-3">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono font-medium bg-[#757F6C]/15 text-[#757F6C] border border-[#757F6C]/40">
                      <AlertTriangle className="w-3.5 h-3.5 text-[#757F6C]" />
                      Entity Ambiguity — Select Candidate
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    <p className="text-[#A5A69D] text-xs font-mono">
                      Multiple matching code entities were found in the knowledge graph:
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                      {response.candidates.map((cand) => (
                        <button
                          key={cand.id}
                          onClick={() => {
                            setEntityId(cand.id);
                            handleAsk(`Why is ${cand.label} configured this way?`, cand.id);
                          }}
                          className="p-3 rounded-lg bg-[#080907] border border-[#292A23] hover:border-[#B9915E]/50 text-left transition-colors group cursor-pointer"
                        >
                          <div className="flex items-center justify-between text-xs font-mono text-[#757F6C] mb-1">
                            <span>{cand.type}</span>
                            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                          </div>
                          <div className="font-mono text-sm font-semibold text-[#F5F3ED]">
                            {cand.label}
                          </div>
                          <div className="text-[11px] font-mono text-[#A5A69D] mt-0.5">
                            {cand.id}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Confidence Signals Inspector */}
              {response.confidence && (
                <div className="rounded-xl border border-[#292A23] bg-[#12130F] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-[#757F6C]" />
                      <span className="text-xs font-mono font-semibold uppercase tracking-wider text-[#F5F3ED]">
                        Confidence Signals:
                      </span>
                      <span className="font-mono text-xs font-medium px-2 py-0.5 rounded-md bg-[#080907] text-[#757F6C] border border-[#292A23]">
                        {Math.round(response.confidence.score * 100)}% ({response.confidence.label})
                      </span>
                    </div>
                    <button
                      onClick={() => setShowConfidenceSignals((s) => !s)}
                      className="flex items-center gap-1 text-xs font-mono text-[#A5A69D] hover:text-[#F5F3ED] transition-colors cursor-pointer"
                    >
                      <span>{showConfidenceSignals ? 'Hide signals' : 'Inspect signals'}</span>
                      {showConfidenceSignals ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {showConfidenceSignals && response.confidence.signals && (
                    <div className="pt-2.5 border-t border-[#292A23] grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">
                      {Object.entries(response.confidence.signals).map(([key, val]) => (
                        <div key={key} className="p-2.5 rounded-lg bg-[#080907] border border-[#292A23] space-y-1.5">
                          <span className="text-[10px] text-[#A5A69D] uppercase block truncate">
                            {key.replace(/_/g, ' ')}
                          </span>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-[#F5F3ED]">
                              {typeof val === 'number' ? (val <= 1.0 ? `${Math.round(val * 100)}%` : val) : String(val)}
                            </span>
                            <div className="w-12 h-1 rounded bg-[#12130F] overflow-hidden border border-[#292A23]">
                              <div
                                className="h-full bg-[#757F6C] rounded"
                                style={{ width: `${Math.min(Number(val) * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </main>

        {/* Evidence receipts margin */}
        {showEvidencePanel && (
          <aside className="w-full lg:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-[#292A23] lg:max-h-full lg:overflow-y-auto">
            <ContextualEvidenceMargin
              citations={activeCitations}
              evidenceGaps={activeEvidenceGaps}
              whoToAsk={activeWhoToAsk}
              selectedCitationId={selectedCitationId}
              onSelectCitation={(id) => setSelectedCitationId(id)}
              onOpenDecision={(id) => setSelectedDecisionId(id)}
            />
          </aside>
        )}
      </div>

      {/* Ask Input Bar & Option B: Expandable Suggestions */}
      <div className="shrink-0 border-t border-[#292A23] bg-[#0B0C09] px-4 sm:px-6 py-3.5 z-20">
        <div className="max-w-4xl mx-auto space-y-2.5">
          {/* Query Composer */}
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A5A69D] pointer-events-none" />
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isLoading) {
                  handleAsk();
                }
              }}
              placeholder="Ask why code is like this (e.g. Why was MAX_RETRIES changed?)"
              className="w-full pl-10 pr-32 py-2.5 bg-[#080907] border border-[#292A23] rounded-lg text-[#F5F3ED] placeholder:text-[#A5A69D]/60 font-sans text-xs sm:text-sm focus:outline-none focus:border-[#B9915E]/70 focus:ring-1 focus:ring-[#B9915E]/40 transition-colors"
            />
            <button
              onClick={() => handleAsk()}
              disabled={isLoading || question.trim().length < 3}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3.5 py-1.5 rounded-md bg-[#757F6C] hover:bg-[#8A9680] text-[#080907] font-semibold font-sans text-xs flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Querying...</span>
                </>
              ) : (
                <>
                  <span>Investigate</span>
                  <Send className="w-3 h-3" />
                </>
              )}
            </button>
          </div>

          {/* Option B: Expandable Suggested Questions */}
          {groundedQuestions.length > 0 && (
            <div className="rounded-lg bg-[#12130F] border border-[#292A23] overflow-hidden transition-all duration-200">
              {/* Compact Collapsed Row */}
              <div className="px-3.5 py-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-5 h-5 rounded-md bg-[#080907] border border-[#292A23] flex items-center justify-center shrink-0 text-[#B9915E]">
                    <Sparkles className="w-3 h-3" />
                  </div>
                  <span className="text-xs font-semibold text-[#F5F3ED] truncate">
                    Try an example question
                  </span>
                  <span className="text-xs text-[#A5A69D] hidden sm:inline truncate">
                    Explore example questions to get started.
                  </span>
                </div>

                <button
                  type="button"
                  id="browse-suggestions-btn"
                  aria-expanded={isSuggestionsExpanded}
                  aria-controls="suggested-questions-panel"
                  onClick={() => setIsSuggestionsExpanded((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#B9915E] hover:text-[#C9A776] transition-colors shrink-0 cursor-pointer"
                >
                  <span>Browse suggestions</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                      isSuggestionsExpanded ? 'rotate-180' : ''
                    }`}
                  />
                </button>
              </div>

              {/* Smoothly Expandable Panel */}
              {isSuggestionsExpanded && (
                <div
                  id="suggested-questions-panel"
                  role="region"
                  aria-labelledby="browse-suggestions-btn"
                  className="border-t border-[#292A23] p-3 bg-[#080907]/60 flex flex-wrap gap-2 transition-all duration-200 motion-reduce:transition-none"
                >
                  {groundedQuestions.map((sq, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setQuestion(sq.question);
                        if (sq.entityId) setEntityId(sq.entityId);
                      }}
                      disabled={isLoading}
                      className="group text-left px-3 py-2 rounded-md bg-[#080907] hover:bg-[#181914] border border-[#292A23] hover:border-[#B9915E]/40 transition-colors flex flex-col gap-1 cursor-pointer max-w-full"
                    >
                      <span className="text-xs font-medium text-[#F5F3ED] group-hover:text-white leading-snug">
                        {sq.question}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-[#A5A69D]">
                        <span className="text-[#757F6C]">{sq.label}</span>
                        {sq.tag && (
                          <span className="px-1.5 py-0.2 rounded bg-[#12130F] text-[#B9915E] border border-[#292A23]">
                            {sq.tag}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <DecisionDrawer
        decisionId={selectedDecisionId}
        onClose={() => setSelectedDecisionId(null)}
        onSelectDecision={(id) => setSelectedDecisionId(id)}
        onSelectCitation={(citId) => setSelectedCitationId(citId)}
      />
    </div>
  );
};

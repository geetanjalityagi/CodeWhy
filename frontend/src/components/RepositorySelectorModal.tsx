import React, { useEffect, useRef, useState } from 'react';
import type { Repository } from '../types';
import { 
  GitBranch, 
  Search, 
  Check, 
  ExternalLink, 
  X, 
  Database, 
  ShieldCheck, 
  FileCode, 
  GitCommit,
  GitPullRequest,
  Plus,
} from 'lucide-react';

interface LegacyRepositorySelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  repositories: Repository[];
  selectedRepo: Repository | null;
  onSelectRepo: (repo: Repository) => void;
  onAddNewRepo?: (newRepo: Repository) => void;
}

// Only show these two repos in the selector
const ALLOWED_REPOS = ['urllib3/urllib3', 'sqlalchemy/alembic'];

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

export const LegacyRepositorySelectorModal: React.FC<LegacyRepositorySelectorModalProps> = ({
  isOpen,
  onClose,
  repositories,
  selectedRepo,
  onSelectRepo,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  if (!isOpen) return null;

  const filteredRepos = repositories
    .filter(r => ALLOWED_REPOS.some(name => r.name === name || r.id === name.replace('/', '-')))
    .filter(r =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.owner && r.owner.toLowerCase().includes(searchQuery.toLowerCase()))
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Backdrop */}
      <div
        className="fixed inset-0 transition-opacity"
        style={{ background: 'rgba(0,0,0,0.75)' }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-xl rounded-xl overflow-hidden z-10 flex flex-col"
        style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--border)',
          boxShadow: '0 0 60px rgba(0,0,0,0.6), 0 0 30px rgba(192,193,255,0.05)',
          maxHeight: '80vh',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="p-2 rounded-lg"
              style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-glow)' }}
            >
              <GitBranch className="w-4 h-4" style={{ color: 'var(--primary)' }} />
            </div>
            <div>
              <h3
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontWeight: 700,
                  fontSize: '15px',
                  color: 'var(--text)',
                  margin: 0,
                }}
              >
                Select Repository
              </h3>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0, marginTop: '2px', fontFamily: 'monospace' }}>
                Choose a repository to inspect architectural provenance
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg cursor-pointer transition-colors"
            style={{ color: 'var(--text-muted)', background: 'transparent' }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-hover)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
            }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-4 pb-2">
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ background: 'var(--surface-lowest)', border: '1px solid var(--border)' }}
          >
            <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
            <input
              type="text"
              placeholder="Filter repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: '12px',
                fontFamily: 'monospace',
                color: 'var(--text)',
              }}
            />
          </div>
        </div>

        {/* Repo List */}
        <div className="p-5 pt-3 flex flex-col gap-3 overflow-y-auto">
          {filteredRepos.length === 0 ? (
            <div
              className="text-center py-10 font-mono text-xs"
              style={{ color: 'var(--text-subtle)' }}
            >
              No repositories match "{searchQuery}"
            </div>
          ) : (
            filteredRepos.map((repo) => {
              const isSelected = selectedRepo?.id === repo.id;
              return (
                <div
                  key={repo.id}
                  onClick={() => { onSelectRepo(repo); onClose(); }}
                  className="rounded-xl p-4 cursor-pointer transition-all"
                  style={{
                    background: isSelected ? 'var(--surface-raised)' : 'transparent',
                    border: `1px solid ${isSelected ? 'var(--evidence-emerald)' : 'var(--border)'}`,
                    boxShadow: isSelected ? '0 0 16px rgba(16,185,129,0.10)' : 'none',
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) {
                      (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--primary)';
                      (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-raised)';
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) {
                      (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
                      (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '14px',
                            fontWeight: 600,
                            color: isSelected ? 'var(--evidence-emerald)' : 'var(--text)',
                          }}
                        >
                          {repo.name}
                        </span>
                        {isSelected && (
                          <span
                            className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
                            style={{
                              color: 'var(--evidence-emerald)',
                              background: 'var(--emerald-soft)',
                              border: '1px solid var(--emerald-border)',
                            }}
                          >
                            <Check className="w-3 h-3" /> Active
                          </span>
                        )}
                        {repo.fixture && (
                          <span
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                            style={{
                              color: 'var(--rationale-amber)',
                              background: 'var(--amber-soft)',
                              border: '1px solid var(--amber-border)',
                            }}
                          >
                            fixture
                          </span>
                        )}
                      </div>

                      {repo.scope && (
                        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                          {repo.scope}
                        </p>
                      )}

                      {/* Metrics */}
                      <div className="flex flex-wrap items-center gap-3" style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                        <div className="flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3" style={{ color: 'var(--evidence-emerald)' }} />
                          <span>{repo.counts.decisions} decisions</span>
                        </div>
                        <span style={{ color: 'var(--border-strong)' }}>•</span>
                        <div className="flex items-center gap-1">
                          <FileCode className="w-3 h-3" style={{ color: 'var(--entity-cyan)' }} />
                          <span>{repo.counts.entities} entities</span>
                        </div>
                        <span style={{ color: 'var(--border-strong)' }}>•</span>
                        <div className="flex items-center gap-1">
                          <GitPullRequest className="w-3 h-3" style={{ color: 'var(--primary-container)' }} />
                          <span>{repo.counts.pull_requests} PRs</span>
                        </div>
                        <span style={{ color: 'var(--border-strong)' }}>•</span>
                        <div className="flex items-center gap-1">
                          <GitCommit className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                          <span>{repo.counts.commits} commits</span>
                        </div>
                      </div>
                    </div>

                    {repo.url && (
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-lg flex-shrink-0 transition-colors"
                        style={{ color: 'var(--text-subtle)' }}
                        title="Open on GitHub"
                        onMouseEnter={e => (e.currentTarget as HTMLAnchorElement).style.color = 'var(--primary)'}
                        onMouseLeave={e => (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-subtle)'}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};


interface RepositorySelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  repositories: Repository[];
  selectedRepo: Repository | null;
  onSelectRepo: (repo: Repository) => void;
  onAddNewRepo?: (newRepo: Repository) => void;
}

export const RepositorySelectorModal: React.FC<RepositorySelectorModalProps> = ({
  isOpen,
  onClose,
  repositories,
  selectedRepo,
  onSelectRepo,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'existing' | 'custom'>('existing');
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Dialog keyboard contract: trap Tab inside the modal, close on Escape, and
  // hand focus back to the trigger when the dialog unmounts.
  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = getFocusableElements(dialog);
      (focusable[0] ?? dialog).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = dialogRef.current;
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

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredRepos = repositories.filter(
    (r) =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.owner && r.owner.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/70 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-selector-title"
        aria-describedby="repository-selector-description"
        tabIndex={-1}
        className="relative w-full max-w-2xl bg-[#fffdf8] border border-[#d7d2c6] rounded-lg shadow-xl overflow-hidden z-10 flex flex-col max-h-[85vh]"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#d7d2c6] bg-[#fffdf8]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded bg-[#efede5] text-[#617c50] border border-[#d7d2c6]">
              <GitBranch className="w-4 h-4" />
            </div>
            <div>
              <h3 id="repository-selector-title" className="text-sm font-semibold text-[#292b25]">Select Target Repository</h3>
              <p id="repository-selector-description" className="text-xs text-[#77776e]">Choose a repository to inspect architectural provenance</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[#77776e] hover:text-[#292b25] rounded hover:bg-[#efede5] transition-colors cursor-pointer"
            aria-label="Close repository selector"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-[#d7d2c6] px-5 bg-[#fffdf8]">
          <button
            onClick={() => setActiveTab('existing')}
            className={`py-2.5 px-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'existing'
                ? 'border-[#718d5e] text-[#292b25]'
                : 'border-transparent text-[#77776e] hover:text-[#292b25]'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            Available Repositories ({repositories.length})
          </button>
          <button
            disabled
            className="py-2.5 px-3 text-xs font-medium border-b-2 border-transparent text-[#929086] cursor-not-allowed flex items-center gap-1.5"
            title="Repositories are ingested with scripts"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Target (disabled)
          </button>
        </div>

        {/* Content Body */}
        {activeTab === 'existing' ? (
          <div className="p-5 flex flex-col gap-3 overflow-y-auto">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#77776e] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Filter by name, owner, or scope..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 bg-[#f5f3ed] border border-[#d7d2c6] rounded text-xs font-mono text-[#292b25] placeholder-[#929086] focus:outline-none focus:border-[#718d5e]"
              />
            </div>

            {/* Repositories List */}
            <div className="space-y-2.5 mt-1">
              {filteredRepos.length === 0 ? (
                <div className="text-center py-8 text-[#77776e] text-xs font-mono">
                  No repositories match "{searchQuery}"
                </div>
              ) : (
                filteredRepos.map((repo) => {
                  const isSelected = selectedRepo?.id === repo.id;
                  return (
                    <div
                      key={repo.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`${isSelected ? 'Selected repository' : 'Select repository'} ${repo.name}`}
                      onClick={() => {
                        onSelectRepo(repo);
                        onClose();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                          event.preventDefault();
                          onSelectRepo(repo);
                          onClose();
                        }
                      }}
                      className={`group p-3.5 rounded border transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#718d5e] ${
                        isSelected
                          ? 'bg-[#f5f3ed] border-[#718d5e]'
                          : 'bg-[#f5f3ed] border-[#d7d2c6] hover:border-[#bdb8ab]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1 flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-semibold text-[#292b25] group-hover:text-[#617c50] transition-colors truncate">
                              {repo.name}
                            </span>
                            {isSelected && (
                              <span className="flex items-center gap-1 text-[10px] font-mono text-[#3fb950] bg-[#2ea043]/15 border border-[#2ea043]/30 px-1.5 py-0.2 rounded">
                                <Check className="w-3 h-3" /> Selected
                              </span>
                            )}
                            {repo.fixture && (
                              <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.2 rounded">
                                fixture
                              </span>
                            )}
                          </div>

                          {repo.scope && (
                            <p className="text-xs text-[#77776e] line-clamp-1">
                              {repo.scope}
                            </p>
                          )}

                          {/* Metric Pill Grid */}
                          <div className="flex flex-wrap items-center gap-2.5 pt-1.5 text-xs font-mono text-[#77776e]">
                            <div className="flex items-center gap-1 text-[#51534b]">
                              <ShieldCheck className="w-3 h-3 text-[#2ea043]" />
                              <span>{repo.counts.decisions} decisions</span>
                            </div>
                            <span className="text-[#d7d2c6]">•</span>
                            <div className="flex items-center gap-1 text-[#51534b]">
                              <FileCode className="w-3 h-3 text-[#617c50]" />
                              <span>{repo.counts.entities} entities</span>
                            </div>
                            <span className="text-[#d7d2c6]">•</span>
                            <div className="flex items-center gap-1 text-[#51534b]">
                              <GitPullRequest className="w-3 h-3 text-[#a371f7]" />
                              <span>{repo.counts.pull_requests} PRs</span>
                            </div>
                            <span className="text-[#d7d2c6]">•</span>
                            <div className="flex items-center gap-1 text-[#51534b]">
                              <GitCommit className="w-3 h-3 text-[#77776e]" />
                              <span>{repo.counts.commits} commits</span>
                            </div>
                          </div>
                        </div>

                        {repo.url && (
                          <a
                            href={repo.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            className="p-1.5 text-[#77776e] hover:text-[#292b25] hover:bg-[#efede5] rounded transition-colors flex-shrink-0"
                            title="Open repository in GitHub"
                            aria-label={`Open ${repo.name} on GitHub`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className='p-5 space-y-4'>
            <div className='rounded-lg border border-[#d7d2c6] bg-[#f5f3ed] p-4 text-xs font-mono text-[#77776e]'>
              <p className='font-semibold text-[#292b25] mb-2'>Repositories are ingested with scripts</p>
              <p className='mb-2'>New repositories are added by running the ingest pipeline, not through the UI.</p>
              <code className='block bg-[#fffdf8] border border-[#d7d2c6] rounded px-3 py-2 text-[#292b25]'>
                python -m scripts.ingest --repo owner/repo
              </code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

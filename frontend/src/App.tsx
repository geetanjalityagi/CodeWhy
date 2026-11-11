import { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { Sidebar, type AppTab } from './components/Sidebar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import { RepositorySelectorModal } from './components/RepositorySelectorModal';
import { IntelligenceWorkspace } from './components/IntelligenceWorkspace';
import { DecisionHistoryView } from './components/DecisionHistoryView';
import { RepositoryStatusView } from './components/RepositoryStatusView';
import { GraphExplorerView } from './components/GraphExplorerView';
import { FileDecisionBriefView } from './components/FileDecisionBriefView';
import type { Repository, QuestionContext, AskResponse } from './types';
import { fetchRepositories, fetchHealth } from './services/api';

export function App() {
  const [currentTab, setCurrentTab] = useState<AppTab>('home');
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [repoLoadError, setRepoLoadError] = useState<string | null>(null);
  const [healthDataSource, setHealthDataSource] = useState<string | null>(null);
  const [questionContext, setQuestionContext] = useState<QuestionContext | null>(null);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('codewhy_sidebar_open');
    return saved === null ? true : saved === 'true';
  });

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      localStorage.setItem('codewhy_sidebar_open', String(next));
      return next;
    });
  }, []);

  // Parse repository routes, including the file-level decision brief.
  const parseUrlRoute = useCallback(() => {
    const path = window.location.pathname;
    if (path.startsWith('/r/')) {
      const sub = path.slice(3);
      if (sub.endsWith('/decisions') || sub.includes('/decisions')) {
        const idFromUrl = decodeURIComponent(sub.replace(/\/decisions\/?$/, '')).replace(/\/$/, '');
        if (idFromUrl) {
          return { tab: 'decisions' as const, repoId: idFromUrl };
        }
      }
      if (sub.endsWith('/status') || sub.includes('/status')) {
        const idFromUrl = decodeURIComponent(sub.replace(/\/status\/?$/, '')).replace(/\/$/, '');
        if (idFromUrl) {
          return { tab: 'status' as const, repoId: idFromUrl };
        }
      }
      if (sub.endsWith('/graph') || sub.includes('/graph')) {
        const idFromUrl = decodeURIComponent(sub.replace(/\/graph\/?$/, '')).replace(/\/$/, '');
        if (idFromUrl) {
          return { tab: 'graph' as const, repoId: idFromUrl };
        }
      }
      if (sub.endsWith('/investigate') || sub.includes('/investigate')) {
        const idFromUrl = decodeURIComponent(sub.replace(/\/investigate\/?$/, '')).replace(/\/$/, '');
        if (idFromUrl) {
          return { tab: 'workspace' as const, repoId: idFromUrl };
        }
      }
      if (sub.endsWith('/file')) {
        const idFromUrl = decodeURIComponent(sub.replace(/\/file\/?$/, '')).replace(/\/$/, '');
        if (idFromUrl) {
          return { tab: 'file' as const, repoId: idFromUrl };
        }
      }
      const idFromUrl = decodeURIComponent(sub).replace(/\/$/, '');
      if (idFromUrl) {
        return { tab: 'workspace' as const, repoId: idFromUrl };
      }
    }
    return { tab: 'home' as const, repoId: null };
  }, []);

  // Update URL history when switching tabs or repo
  const navigateToTab = useCallback(
    (tab: AppTab, repo?: Repository | null) => {
      setCurrentTab(tab);
      const targetRepo = repo || selectedRepo;
      if (tab === 'decisions' && targetRepo) {
        const newUrl = `/r/${encodeURIComponent(targetRepo.id)}/decisions`;
        if (window.location.pathname !== newUrl) {
          window.history.pushState(null, '', newUrl);
        }
      } else if (tab === 'status' && targetRepo) {
        const newUrl = `/r/${encodeURIComponent(targetRepo.id)}/status`;
        if (window.location.pathname !== newUrl) {
          window.history.pushState(null, '', newUrl);
        }
      } else if (tab === 'graph' && targetRepo) {
        const newUrl = `/r/${encodeURIComponent(targetRepo.id)}/graph`;
        if (window.location.pathname !== newUrl) {
          window.history.pushState(null, '', newUrl);
        }
      } else if (tab === 'workspace' && targetRepo) {
        const newUrl = `/r/${encodeURIComponent(targetRepo.id)}`;
        if (window.location.pathname !== newUrl) {
          window.history.pushState(null, '', newUrl);
        }
      } else if (tab === 'file' && targetRepo) {
        const newUrl = `/r/${encodeURIComponent(targetRepo.id)}/file`;
        if (window.location.pathname !== newUrl) {
          window.history.pushState(null, '', newUrl);
        }
      } else if (tab === 'home') {
        if (window.location.pathname !== '/') {
          window.history.pushState(null, '', '/');
        }
      }
    },
    [selectedRepo]
  );

  // Initial Data & Route setup
  useEffect(() => {
    const route = parseUrlRoute();

    async function loadData() {
      try {
        const [repoData, healthResult] = await Promise.all([
          fetchRepositories(),
          fetchHealth().catch(() => ({ health: null, latencyMs: 0, isConnected: false })),
        ]);
        if (healthResult?.health?.data_source) {
          setHealthDataSource(healthResult.health.data_source);
        }
        if (repoData.items.length > 0) {
          setRepositories(repoData.items);
        } else {
          setRepoLoadError('The API returned no repositories.');
          return;
        }

        // Resolve active repository based on URL or saved state
        if ((route.tab === 'workspace' || route.tab === 'decisions' || route.tab === 'status' || route.tab === 'graph' || route.tab === 'file') && route.repoId) {
          const foundInLoaded = repoData.items.find((r) => r.id === route.repoId);
          if (foundInLoaded) {
            setSelectedRepo(foundInLoaded);
          } else {
            // Create stub repo for ID if not yet in list
            setSelectedRepo({
              id: route.repoId,
              name: route.repoId,
              url: `https://github.com/${route.repoId}`,
              counts: { decisions: 0, entities: 0, pull_requests: 0, commits: 0 },
              fixture: false,
            });
          }
          setCurrentTab(route.tab);
        } else {
          // Home page default
          const savedRepoId = localStorage.getItem('codewhy_selected_repo');
          const found = savedRepoId ? repoData.items.find((r) => r.id === savedRepoId) : null;
          if (found) {
            setSelectedRepo(found);
          } else if (repoData.items.length > 0) {
            setSelectedRepo(repoData.items[0]);
          }
          setCurrentTab('home');
        }
      } catch {
        setRepoLoadError('The API is not reachable. Check that the backend is running.');
      }
    }

    loadData();

    // Listen for browser popstate (back/forward buttons)
    const handlePopState = () => {
      const r = parseUrlRoute();
      if (r.tab === 'decisions' && r.repoId) {
        setCurrentTab('decisions');
      } else if (r.tab === 'status' && r.repoId) {
        setCurrentTab('status');
      } else if (r.tab === 'graph' && r.repoId) {
        setCurrentTab('graph');
      } else if (r.tab === 'workspace' && r.repoId) {
        setCurrentTab('workspace');
      } else if (r.tab === 'file' && r.repoId) {
        setCurrentTab('file');
      } else {
        setCurrentTab('home');
      }
    };
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [parseUrlRoute]);

  const handleSelectRepo = (repo: Repository) => {
    if (selectedRepo?.id !== repo.id) {
      setQuestionContext(null);
    }
    setSelectedRepo(repo);
    localStorage.setItem('codewhy_selected_repo', repo.id);
    if (currentTab === 'decisions') {
      window.history.pushState(null, '', `/r/${encodeURIComponent(repo.id)}/decisions`);
    } else if (currentTab === 'status') {
      window.history.pushState(null, '', `/r/${encodeURIComponent(repo.id)}/status`);
    } else if (currentTab === 'graph') {
      window.history.pushState(null, '', `/r/${encodeURIComponent(repo.id)}/graph`);
    } else if (currentTab === 'workspace') {
      window.history.pushState(null, '', `/r/${encodeURIComponent(repo.id)}`);
    } else if (currentTab === 'file') {
      window.history.pushState(null, '', `/r/${encodeURIComponent(repo.id)}/file`);
    }
  };

  const handleAddNewRepo = (newRepo: Repository) => {
    setRepositories((prev) => [newRepo, ...prev]);
  };

  const [workspaceQuestion, setWorkspaceQuestion] = useState<string | undefined>();

  const handleQuestionAnswered = (question: string, response: AskResponse) => {
    if (!selectedRepo) return;
    setQuestionContext({ repositoryId: selectedRepo.id, question, response });
  };

  if (repoLoadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--canvas)] text-[var(--text)]">
        <div className="text-center space-y-4">
          <p className="text-lg font-semibold">{repoLoadError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded bg-[var(--primary)] text-white text-sm font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen flex flex-col font-sans${
        currentTab === 'home'
          ? ' cw-landing'
          : currentTab === 'workspace'
          ? ' cw-investigate-page'
          : currentTab === 'decisions'
          ? ' cw-decisions-page'
          : currentTab === 'file'
          ? ' cw-file-page'
          : currentTab === 'status'
          ? ' cw-status-page'
          : currentTab === 'graph'
          ? ' cw-graph-page'
          : ''
      }`}
      style={{
        backgroundColor: currentTab === 'home' || currentTab === 'workspace' || currentTab === 'decisions' || currentTab === 'file' || currentTab === 'status' || currentTab === 'graph' ? 'var(--cw-bg)' : 'var(--canvas)',
        color: currentTab === 'home' || currentTab === 'workspace' || currentTab === 'decisions' || currentTab === 'file' || currentTab === 'status' || currentTab === 'graph' ? 'var(--cw-text)' : 'var(--text)',
      }}
    >
      <Navbar
        variant={currentTab === 'home' || currentTab === 'workspace' || currentTab === 'decisions' || currentTab === 'file' || currentTab === 'status' || currentTab === 'graph' ? 'landing' : 'default'}
        onSelectTab={(tab) => navigateToTab(tab)}
        selectedRepo={selectedRepo}
        onOpenRepoSelector={() => setIsSelectorOpen(true)}
      />

      {healthDataSource && healthDataSource !== 'graph' && (
        <div
          data-testid="data-source-banner"
          className="w-full bg-amber-500/20 text-amber-950 border-b border-amber-500/40 px-4 py-2 text-center text-xs font-mono font-bold tracking-wide z-30"
          role="alert"
        >
          Not running on the real graph, results may differ
        </div>
      )}
      {(selectedRepo?.fixture || repositories.some((r) => r.fixture)) && (
        <div
          data-testid="fixture-banner"
          className="w-full bg-rose-500/20 text-rose-950 border-b border-rose-500/40 px-4 py-2 text-center text-xs font-mono font-bold tracking-wide z-30"
          role="alert"
        >
          SAMPLE DATA, NOT REAL HISTORY
        </div>
      )}

      <div className="flex flex-1 z-10 min-h-0">
        <Sidebar
          variant={currentTab === 'home' || currentTab === 'workspace' || currentTab === 'decisions' || currentTab === 'file' || currentTab === 'status' || currentTab === 'graph' ? 'landing' : 'default'}
          currentTab={currentTab}
          onSelectTab={(tab) => navigateToTab(tab)}
          isOpen={sidebarOpen}
          onToggle={toggleSidebar}
        />

        {/* Main Content Area */}
        <main
          className="flex-1 flex flex-col min-w-0"
          style={{ backgroundColor: currentTab === 'home' || currentTab === 'workspace' || currentTab === 'decisions' || currentTab === 'file' || currentTab === 'status' || currentTab === 'graph' ? 'var(--cw-bg)' : 'var(--canvas)' }}
        >
          {currentTab === 'home' ? (
            <Hero
              repositories={repositories}
              selectedRepo={selectedRepo}
              onSelectRepo={handleSelectRepo}
              onNavigateToWorkspace={(question?: string) => {
                if (question) setWorkspaceQuestion(question);
                navigateToTab('workspace');
              }}
            />
          ) : currentTab === 'workspace' ? (
            <IntelligenceWorkspace
              selectedRepo={selectedRepo}
              onQuestionAnswered={handleQuestionAnswered}
              initialQuestion={workspaceQuestion}
            />
          ) : currentTab === 'decisions' ? (
            <DecisionHistoryView
              selectedRepo={selectedRepo}
              questionContext={questionContext}
              onAskQuestion={() => navigateToTab('workspace')}
            />
          ) : currentTab === 'graph' ? (
            <GraphExplorerView
              selectedRepo={selectedRepo}
              questionContext={questionContext}
              onAskQuestion={() => navigateToTab('workspace')}
            />
          ) : currentTab === 'file' ? (
            <FileDecisionBriefView
              key={selectedRepo?.id}
              selectedRepo={selectedRepo}
            />
          ) : (
            <RepositoryStatusView
              selectedRepo={selectedRepo}
            />
          )}
        </main>
      </div>

      <RepositorySelectorModal
        isOpen={isSelectorOpen}
        onClose={() => setIsSelectorOpen(false)}
        repositories={repositories}
        selectedRepo={selectedRepo}
        onSelectRepo={handleSelectRepo}
        onAddNewRepo={handleAddNewRepo}
      />

      {currentTab !== 'home' && <Footer />}
    </div>
  );
}

export default App;

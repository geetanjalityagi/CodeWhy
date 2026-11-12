import type {
  Repository,
  HealthResponse,
  DependenciesResponse,
  AskRequest,
  AskResponse,
  DecisionListResponse,
  DecisionDetail,
  GraphResponse,
  EntityListResponse,
} from '../types';


export interface GroundedQuestion {
  label: string;
  question: string;
  outcomeType: 'full' | 'partial' | 'refusal' | 'ambiguous';
  tag: string;
  entityId?: string;
}

export const GROUNDED_DEMO_QUESTIONS: Record<string, GroundedQuestion[]> = {
  'urllib3-urllib3': [
    {
      label: 'Demonstrates: RFC 9113 HTTP/2 TLS support',
      question: 'Why was src/urllib3/util/ssl_.py changed for HTTP/2 TLS support?',
      outcomeType: 'full',
      tag: 'Full Answer',
      entityId: 'file:urllib3/urllib3:src/urllib3/util/ssl_.py',
    },
    {
      label: 'Demonstrates: Commit revert supersession',
      question: 'Why was src/urllib3/util/ssl_.py reverted for HTTP/2 TLS?',
      outcomeType: 'full',
      tag: 'Full Answer (Supersedes PR #3456)',
      entityId: 'file:urllib3/urllib3:src/urllib3/util/ssl_.py',
    },
    {
      label: 'Demonstrates: Multi-decision file history',
      question: 'Why was src/urllib3/util/url.py changed?',
      outcomeType: 'full',
      tag: 'Full Answer',
      entityId: 'file:urllib3/urllib3:src/urllib3/util/url.py',
    },
    {
      label: 'Demonstrates: Low score refusal (below similarity threshold)',
      question: 'Why was support for Python 2.6 dropped in urllib3?',
      outcomeType: 'refusal',
      tag: 'Refusal (Low Score)',
      entityId: 'file:urllib3/urllib3:src/urllib3/__init__.py',
    },
    {
      label: 'Demonstrates: Out of scope off-topic refusal',
      question: 'Why does urllib3 use Kubernetes for orchestration?',
      outcomeType: 'refusal',
      tag: 'Refusal (Entity Not Found)',
    },
    {
      label: 'Demonstrates: Non-existent file entity refusal',
      question: 'Why does this code exist?',
      outcomeType: 'refusal',
      tag: 'Refusal (Entity Not Found)',
      entityId: 'file:urllib3/urllib3:does/not/exist.py',
    },
  ],
  'sqlalchemy-alembic': [
    {
      label: 'Demonstrates: SQLite batch operation workaround',
      question: 'Why avoid using CAST(x as JSON) in SQLite batch operations?',
      outcomeType: 'full',
      tag: 'Full Answer',
      entityId: 'file:sqlalchemy/alembic:alembic/operations/batch.py',
    },
    {
      label: 'Demonstrates: Warning caller attribution',
      question: "Why report warnings from the caller's file and line number instead of utils.py?",
      outcomeType: 'full',
      tag: 'Full Answer',
      entityId: 'file:sqlalchemy/alembic:alembic/util/messaging.py',
    },
    {
      label: 'Demonstrates: Asyncio cookbook connection cleanup',
      question: 'Why add engine.dispose() to the asyncio cookbook example?',
      outcomeType: 'full',
      tag: 'Full Answer',
    },
  ],
};

export async function fetchRepositories(): Promise<{ items: Repository[]; isLive: boolean }> {
  const res = await fetch('/api/v1/repositories', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('The API returned no repositories.');
  }
  const items: Repository[] = data.items;
  return { items, isLive: true };
}

export async function fetchRepository(repositoryId: string): Promise<Repository | null> {
  const res = await fetch(`/api/v1/repositories/${encodeURIComponent(repositoryId)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchHealth(): Promise<{ health: HealthResponse | null; latencyMs: number; isConnected: boolean }> {
  const start = performance.now();
  try {
    const res = await fetch('/api/v1/health', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Math.round(performance.now() - start);
    if (!res.ok) {
      return { health: null, latencyMs, isConnected: false };
    }
    const data = await res.json();
    return { health: data, latencyMs, isConnected: true };
  } catch {
    const latencyMs = Math.round(performance.now() - start);
    return { health: null, latencyMs, isConnected: false };
  }
}

export async function fetchDependencies(): Promise<DependenciesResponse | null> {
  try {
    const res = await fetch('/api/v1/health/dependencies', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function askQuestion(
  repositoryId: string,
  request: AskRequest
): Promise<AskResponse> {
  const res = await fetch(`/api/v1/repositories/${encodeURIComponent(repositoryId)}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    let errorDetail = `Request failed with status ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.detail) {
        errorDetail = typeof errJson.detail === 'string' ? errJson.detail : JSON.stringify(errJson.detail);
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(errorDetail);
  }

  const data: AskResponse = await res.json();
  return data;
}

export async function fetchRepositoryDecisions(
  repositoryId: string,
  options?: { entity_id?: string; state?: string; limit?: number; offset?: number }
): Promise<DecisionListResponse> {
  const params = new URLSearchParams();
  if (options?.entity_id) params.set('entity_id', options.entity_id);
  if (options?.state) params.set('state', options.state);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));

  const url = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/decisions${
    params.toString() ? `?${params.toString()}` : ''
  }`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch decisions: ${res.statusText}`);
  }

  return await res.json();
}

export async function fetchDecisionDetail(decisionId: string): Promise<DecisionDetail> {
  const res = await fetch(`/api/v1/decisions/${encodeURIComponent(decisionId)}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch decision details: ${res.statusText}`);
  }

  return await res.json();
}

export async function fetchRepositoryGraph(
  repositoryId: string,
  entityId?: string
): Promise<GraphResponse | null> {
  try {
    const url = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/graph${
      entityId ? `?entity_id=${encodeURIComponent(entityId)}` : ''
    }`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchEntitySearch(
  repositoryId: string,
  q: string
): Promise<EntityListResponse | null> {
  try {
    return await searchRepositoryEntities(repositoryId, q);
  } catch {
    return null;
  }
}

export async function searchRepositoryEntities(
  repositoryId: string,
  q: string
): Promise<EntityListResponse> {
  const url = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/entities?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`Failed to search repository entities: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchRepositoryDecisionHistory(
  repositoryId: string
): Promise<DecisionListResponse> {
  const limit = 200;
  const firstPage = await fetchRepositoryDecisions(repositoryId, { limit, offset: 0 });
  const items = [...firstPage.items];
  let offset = items.length;

  while (offset < firstPage.total) {
    const page = await fetchRepositoryDecisions(repositoryId, { limit, offset });
    if (page.items.length === 0) {
      throw new Error('Decision history pagination stopped before all decisions were loaded');
    }
    items.push(...page.items);
    offset = items.length;
  }

  return { ...firstPage, items, limit, offset: 0 };
}


export type GraphFetchResult =
  | { status: 'ok'; data: GraphResponse }
  | { status: 'offline' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export async function fetchRepositoryGraphResult(
  repositoryId: string,
  entityId?: string
): Promise<GraphFetchResult> {
  try {
    const url = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/graph${
      entityId ? `?entity_id=${encodeURIComponent(entityId)}` : ''
    }`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 503) return { status: 'offline' };
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    const data: GraphResponse = await res.json();
    return { status: 'ok', data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout')) {
      return { status: 'offline' };
    }
    return { status: 'error', message: msg };
  }
}


// ─── On-Demand Ingestion API ───────────────────────────────────────────────

export interface IngestJobStatus {
  job_id: string;
  repo: string;
  status: 'queued' | 'cloning' | 'fetching' | 'extracting' | 'building_graph' | 'done' | 'failed';
  phase: string | null;
  progress_pct: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  result_repo_id: string | null;
}

export async function startIngest(repo: string, maxPrs = 100): Promise<IngestJobStatus> {
  const res = await fetch('/api/v1/repositories/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ repo, max_prs: maxPrs }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchIngestStatus(jobId: string): Promise<IngestJobStatus> {
  const res = await fetch(`/api/v1/repositories/ingest/${jobId}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

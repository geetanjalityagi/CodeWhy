import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Repository,
  HealthResponse,
  DependenciesResponse,
} from '../types';
import {
  fetchHealth,
  fetchDependencies,
  fetchRepository,
} from '../services/api';
import {
  Activity,
  Server,
  Database,
  GitPullRequest,
  GitCommit,
  CheckCircle2,
  HelpCircle,
  XCircle,
  Clock,
  FileCode,
  ShieldCheck,
  Cpu,
  RefreshCw,
  Box,
  ArrowRight,
} from 'lucide-react';

interface RepositoryStatusViewProps {
  selectedRepo: Repository | null;
}

export const RepositoryStatusView: React.FC<RepositoryStatusViewProps> = ({
  selectedRepo,
}) => {
  const [repoData, setRepoData] = useState<Repository | null>(selectedRepo);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [dependencies, setDependencies] = useState<DependenciesResponse | null>(null);
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [isHealthOnline, setIsHealthOnline] = useState<boolean>(false);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [hasPolled, setHasPolled] = useState<boolean>(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState<boolean>(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const isPollingRef = useRef(false);

  // Track mount state so a slow poll cannot update an unmounted page.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Determine repository ID from props or path URL
  const urlRepoId = typeof window !== 'undefined'
    ? window.location.pathname.match(/\/r\/([^/]+)/)?.[1]
    : null;
  const repoId = selectedRepo?.id || (urlRepoId ? decodeURIComponent(urlRepoId) : '');

  // Keep repoData in sync with selectedRepo prop
  useEffect(() => {
    if (selectedRepo) {
      setRepoData(selectedRepo);
    }
  }, [selectedRepo]);

  // Load telemetry data from the three specified endpoints
  const pollTelemetry = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      // 1. GET /api/v1/health
      const healthResult = await fetchHealth();
      if (!isMountedRef.current) return;
      setHealth(healthResult.health);
      setIsHealthOnline(healthResult.isConnected);
      setLatencyMs(healthResult.latencyMs);

      // 2. GET /api/v1/health/dependencies
      const depResult = await fetchDependencies();
      if (!isMountedRef.current) return;
      setDependencies(depResult);

      // 3. GET /api/v1/repositories/{id}
      if (repoId) {
        const repoResult = await fetchRepository(repoId);
        if (!isMountedRef.current) return;
        if (repoResult) {
          setRepoData(repoResult);
        }
      }

      if (!isMountedRef.current) return;
      setPollError(null);
      setLastPolledAt(new Date());
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      setPollError(err instanceof Error ? err.message : 'Telemetry poll failed');
    } finally {
      isPollingRef.current = false;
      if (isMountedRef.current) setHasPolled(true);
    }
  }, [repoId]);

  // Initial fetch and 30-second interval polling
  useEffect(() => {
    pollTelemetry();

    const interval = setInterval(() => {
      pollTelemetry();
    }, 30000); // 30-second polling as specified

    return () => clearInterval(interval);
  }, [pollTelemetry]);

  const handleManualRefresh = async () => {
    setIsManualRefreshing(true);
    try {
      await pollTelemetry();
    } finally {
      if (isMountedRef.current) setIsManualRefreshing(false);
    }
  };

  // Determine graph / storage status
  const neo4jDep = dependencies?.services.find((s) => s.name.toLowerCase() === 'neo4j');
  const isGraphRemoteConfigured = neo4jDep?.status === 'configured';
  const activeDataSource = health?.data_source || dependencies?.data_source || 'sqlite';

  // Derive every status label from real runtime state instead of asserting health.
  const hasSuccessfulPoll = lastPolledAt !== null;
  const pipelineStatus = pollError
    ? 'Degraded'
    : !hasPolled
      ? 'Checking'
      : isHealthOnline
        ? 'Operational'
        : 'Offline';
  const pipelineStatusClass = pollError
    ? 'bg-[#da3633]/15 text-[#f85149] border border-[#da3633]/30'
    : !hasPolled
      ? 'bg-[#181914] text-[#A5A69D] border border-[#292A23]'
      : isHealthOnline
        ? 'bg-[#2ea043]/15 text-[#3fb950] border border-[#2ea043]/30'
        : 'bg-[#da3633]/15 text-[#f85149] border border-[#da3633]/30';
  const queryAvailability = pollError
    ? 'Unknown'
    : !hasPolled
      ? 'Checking…'
      : isHealthOnline
        ? 'Available'
        : 'Unavailable';
  const queryAvailabilityClass =
    queryAvailability === 'Available'
      ? 'text-[#3fb950]'
      : queryAvailability === 'Checking…'
        ? 'text-[#A5A69D]'
        : 'text-[#f85149]';
  const pollingLabel = pollError
    ? 'Auto-poll retrying every 30s'
    : hasSuccessfulPoll
      ? 'Auto-poll active (30s)'
      : 'Auto-poll scheduled (30s)';

  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] bg-[#080907] w-full text-[#F5F3ED]">
      {/* Top Header & Breadcrumb Bar */}
      <div className="border-b border-[#292A23] bg-[#0B0C09]/95 backdrop-blur-md px-4 sm:px-6 lg:px-8 py-5">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3 pt-1">
              <div className="p-2 rounded-xl bg-[#080907] text-[#B9915E] border border-[#292A23]">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold font-sans text-[#F5F3ED] tracking-tight flex items-center gap-2.5">
                  <span>Repository Telemetry & Provenance Pipeline</span>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold ${
                      !hasPolled
                        ? 'bg-[#181914] text-[#A5A69D] border border-[#292A23]'
                        : isHealthOnline
                          ? 'bg-[#2ea043]/15 text-[#3fb950] border border-[#2ea043]/30'
                          : 'bg-[#da3633]/15 text-[#f85149] border border-[#da3633]/30'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        !hasPolled
                          ? 'bg-[#A5A69D]'
                          : isHealthOnline
                            ? 'bg-[#3fb950] animate-pulse'
                            : 'bg-[#f85149]'
                      }`}
                    />
                    {!hasPolled ? 'Checking API…' : isHealthOnline ? 'Live API Online' : 'Service Offline'}
                  </span>
                </h1>
                <p className="text-xs text-[#A5A69D] font-mono">
                  Telemetry polled every 30s • Active source: {activeDataSource} • Exact contract schema
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleManualRefresh}
              disabled={isManualRefreshing}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#757F6C]/15 hover:bg-[#757F6C]/30 text-[#F5F3ED] border border-[#757F6C]/40 text-xs font-mono transition-colors cursor-pointer"
              title="Manual Poll Telemetry"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-[#B9915E] ${isManualRefreshing ? 'animate-spin' : ''}`} />
              <span>Poll Now</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full flex-1 space-y-8">
        
        {/* Telemetry Polling Header Callout */}
        <div className="p-4 rounded-xl bg-[#12130F] border border-[#292A23] flex flex-wrap items-center justify-between gap-4 text-xs font-mono shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#080907] text-[#B9915E] border border-[#292A23]">
              <Server className="w-4 h-4" />
            </div>
            <div>
              <span className="text-[#A5A69D] block text-[10px] uppercase tracking-wider font-semibold">
                Active Engine Core
              </span>
              <span className="text-sm font-bold text-[#F5F3ED]">
                CodeWhy Engine {health?.version ? `v${health.version}` : ''} ({activeDataSource} mode)
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4 text-[#A5A69D]">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[#B9915E]" />
              <span>
                {lastPolledAt
                  ? `Last successful poll: ${lastPolledAt.toLocaleTimeString()}`
                  : hasPolled
                    ? 'No successful poll yet'
                    : 'Awaiting first poll'}
              </span>
            </span>
            <span className="px-2 py-0.5 rounded bg-[#080907] text-[#F5F3ED] border border-[#292A23]">
              Latency: {hasSuccessfulPoll ? `${latencyMs}ms` : '—'}
            </span>
            <span className="text-[#757F6C]">{pollingLabel}</span>
          </div>
        </div>

        {pollError && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-[#12130F] border border-[#da3633]/40 text-[#f85149] text-xs font-mono flex items-start gap-2.5"
          >
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Telemetry poll failed: {pollError}. The values above are from the last successful poll.
            </span>
          </div>
        )}

        {/* 1. PIPELINE OVERVIEW: Ingest → Extract → Graph */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono uppercase tracking-wider text-[#A5A69D] font-bold">
                Archeology Pipeline Lifecycle
              </span>
              <div className="h-px bg-[#292A23] w-24 sm:w-48" />
            </div>

            {/* Visual Pipeline Flow: Ingest → Extract → Graph */}
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="px-2.5 py-0.5 rounded-lg bg-[#080907] text-[#AFD2FA] border border-[#AFD2FA]/30 font-semibold flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#AFD2FA]" />
                Ingest
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-[#8C806F]" />
              <span className="px-2.5 py-0.5 rounded-lg bg-[#080907] text-[#3fb950] border border-[#2ea043]/30 font-semibold flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950]" />
                Extract
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-[#8C806F]" />
              <span className="px-2.5 py-0.5 rounded-lg bg-[#080907] text-[#B9915E] border border-[#B9915E]/30 font-semibold flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#B9915E]" />
                Graph
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            {/* Stage 1: Ingest */}
            <div className="rounded-xl p-5 bg-[#12130F] border border-[#292A23] space-y-4 relative overflow-hidden group shadow-sm">
              <div className="flex items-center justify-between border-b border-[#292A23] pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-lg bg-[#080907] text-[#AFD2FA] flex items-center justify-center font-mono font-bold text-xs border border-[#292A23]">
                    1
                  </span>
                  <h3 className="font-mono text-sm font-bold text-[#F5F3ED] tracking-wide">
                    Ingest
                  </h3>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#080907] text-[#AFD2FA] border border-[#292A23]">
                  Raw Sources
                </span>
              </div>

              <p className="text-xs text-[#A5A69D] font-sans leading-relaxed">
                Ingests Git commits, merged and unmerged pull requests, and documentation artifacts.
              </p>

              {/* Exact returned counts */}
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23] space-y-1">
                  <span className="text-[10px] text-[#A5A69D] uppercase flex items-center gap-1">
                    <GitPullRequest className="w-3 h-3 text-[#AFD2FA]" /> PRs
                  </span>
                  <span className="text-lg font-bold text-[#F5F3ED]">
                    {repoData?.counts.pull_requests ?? 0}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23] space-y-1">
                  <span className="text-[10px] text-[#A5A69D] uppercase flex items-center gap-1">
                    <GitCommit className="w-3 h-3 text-[#AFD2FA]" /> Commits
                  </span>
                  <span className="text-lg font-bold text-[#F5F3ED]">
                    {repoData?.counts.commits ?? 0}
                  </span>
                </div>
              </div>

              {/* Ingest extra fields only when returned */}
              <div className="space-y-1 pt-1 text-xs font-mono">
                {repoData?.prs_fetched !== undefined && repoData?.prs_fetched !== null && (
                  <div className="flex items-center justify-between text-[#A5A69D]">
                    <span>PRs Fetched:</span>
                    <span className="text-[#F5F3ED] font-bold">{repoData.prs_fetched}</span>
                  </div>
                )}
                {repoData?.sources_analyzed !== undefined && repoData?.sources_analyzed !== null && (
                  <div className="flex items-center justify-between text-[#A5A69D]">
                    <span>Sources Analyzed:</span>
                    <span className="text-[#F5F3ED] font-bold">{repoData.sources_analyzed}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Stage 2: Extract */}
            <div className="rounded-xl p-5 bg-[#12130F] border border-[#292A23] space-y-4 relative overflow-hidden group shadow-sm">
              <div className="flex items-center justify-between border-b border-[#292A23] pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-lg bg-[#080907] text-[#3fb950] flex items-center justify-center font-mono font-bold text-xs border border-[#292A23]">
                    2
                  </span>
                  <h3 className="font-mono text-sm font-bold text-[#F5F3ED] tracking-wide">
                    Extract
                  </h3>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#080907] text-[#3fb950] border border-[#292A23]">
                  Quotes & Rules
                </span>
              </div>

              <p className="text-xs text-[#A5A69D] font-sans leading-relaxed">
                Applies character-level verbatim quote verification and extracts explicit decision records.
              </p>

              {/* Exact returned counts & extraction version (only when returned) */}
              <div className={`grid ${health?.version ? 'grid-cols-2' : 'grid-cols-1'} gap-2 text-xs font-mono`}>
                <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23] space-y-1">
                  <span className="text-[10px] text-[#A5A69D] uppercase flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-[#3fb950]" /> Decisions
                  </span>
                  <span className="text-lg font-bold text-[#F5F3ED]">
                    {repoData?.counts.decisions ?? 0}
                  </span>
                </div>

                {health?.version && (
                  <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23] space-y-1">
                    <span className="text-[10px] text-[#A5A69D] uppercase flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3 text-[#B9915E]" /> Extraction Ver
                    </span>
                    <span className="text-sm font-bold text-[#B9915E] truncate">
                      v{health.version}
                    </span>
                  </div>
                )}
              </div>

              {/* Skipped Work & Verified Decisions (only when returned) */}
              <div className="space-y-1.5 pt-1 text-xs font-mono">
                {repoData?.verified_decisions !== undefined && repoData?.verified_decisions !== null && (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#2ea043]/10 border border-[#2ea043]/20 text-[#3fb950]">
                    <span className="flex items-center gap-1.5 text-[#A5A69D]">
                      <CheckCircle2 className="w-3 h-3 text-[#3fb950]" /> Verified Decisions:
                    </span>
                    <span className="text-[#3fb950] font-bold">{repoData.verified_decisions}</span>
                  </div>
                )}
                {repoData?.prs_noise_skipped !== undefined && repoData?.prs_noise_skipped !== null && (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#d29922]/10 border border-[#d29922]/20 text-[#e3b341]">
                    <span className="flex items-center gap-1.5 text-[#A5A69D]">
                      <ShieldCheck className="w-3 h-3 text-[#e3b341]" /> Skipped Work (Noise PRs):
                    </span>
                    <span className="text-[#e3b341] font-bold">{repoData.prs_noise_skipped}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Stage 3: Graph */}
            <div className="rounded-xl p-5 bg-[#12130F] border border-[#292A23] space-y-4 relative overflow-hidden group shadow-sm">
              <div className="flex items-center justify-between border-b border-[#292A23] pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-lg bg-[#080907] text-[#B9915E] flex items-center justify-center font-mono font-bold text-xs border border-[#292A23]">
                    3
                  </span>
                  <h3 className="font-mono text-sm font-bold text-[#F5F3ED] tracking-wide">
                    Graph
                  </h3>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#080907] text-[#B9915E] border border-[#292A23]">
                  Entities & Lineage
                </span>
              </div>

              <p className="text-xs text-[#A5A69D] font-sans leading-relaxed">
                Connects code entities, temporal supersessions, and evidence receipts into a queryable graph.
              </p>

              {/* Exact returned counts */}
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23] space-y-1">
                  <span className="text-[10px] text-[#A5A69D] uppercase flex items-center gap-1">
                    <FileCode className="w-3 h-3 text-[#B9915E]" /> Entities
                  </span>
                  <span className="text-lg font-bold text-[#F5F3ED]">
                    {repoData?.counts.entities ?? 0}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23] space-y-1">
                  <span className="text-[10px] text-[#A5A69D] uppercase flex items-center gap-1">
                    <Database className="w-3 h-3 text-[#B9915E]" /> Backing
                  </span>
                  <span className="text-xs font-bold text-[#AFD2FA] uppercase truncate">
                    {activeDataSource}
                  </span>
                </div>
              </div>

              {/* Storage State (Local SQLite vs Remote Neo4j) */}
              <div className="pt-1 text-xs font-mono">
                <div className="p-2.5 rounded-lg bg-[#080907] border border-[#292A23] flex items-center justify-between">
                  <span className="text-[#A5A69D]">Graph Database:</span>
                  <span
                    className={`font-semibold ${
                      isGraphRemoteConfigured ? 'text-[#3fb950]' : 'text-[#e3b341]'
                    }`}
                  >
                    {isGraphRemoteConfigured ? 'Neo4j Configured' : 'SQLite Local Mode'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 2. SQLITE-BACKED STATUS USABLE IF GRAPH IS OFFLINE */}
        <div className="p-5 rounded-xl bg-[#12130F] border border-[#292A23] space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-[#B9915E]" />
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#F5F3ED]">
                Persistence & Storage Resilience (SQLite Local Fallback)
              </h3>
            </div>
            <span className={`text-[11px] font-mono px-2 py-0.5 rounded font-medium ${pipelineStatusClass}`}>
              {pipelineStatus}
            </span>
          </div>

          <p className="text-xs font-mono text-[#A5A69D] leading-relaxed">
            CodeWhy is architected with complete local SQLite resilience. If an external graph database
            (Neo4j) is unconfigured or offline, CodeWhy serves all decision queries, quote checks, and
            entity lineage seamlessly using the local SQLite store and in-memory indexes.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs font-mono">
            <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23]">
              <span className="text-[#A5A69D] block text-[10px] uppercase font-mono">Active Data Source</span>
              <span className="text-[#AFD2FA] font-bold text-sm uppercase font-mono">{activeDataSource}</span>
            </div>
            <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23]">
              <span className="text-[#A5A69D] block text-[10px] uppercase font-mono">Graph Query Engine</span>
              <span className="text-[#F5F3ED] font-bold text-sm font-mono">
                {isGraphRemoteConfigured ? 'Remote Neo4j' : 'Local SQLite Graph'}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-[#080907] border border-[#292A23]">
              <span className="text-[#A5A69D] block text-[10px] uppercase font-mono">Query Availability</span>
              <span className={`font-bold text-sm font-mono ${queryAvailabilityClass}`}>
                {queryAvailability}
              </span>
            </div>
          </div>
        </div>

        {/* 3. DEPENDENCY SERVICES STATUS (From GET /api/v1/health/dependencies) */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono uppercase tracking-wider text-[#A5A69D] font-bold">
              Configured Services & Dependencies
            </span>
            <div className="h-px bg-[#292A23] flex-1" />
          </div>

          {dependencies?.services && dependencies.services.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
              {dependencies.services.map((svc) => {
                const isConfigured = svc.status === 'configured';
                return (
                  <div
                    key={svc.name}
                    className="p-4 rounded-xl bg-[#12130F] border border-[#292A23] space-y-2 shadow-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#F5F3ED] uppercase text-xs flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5 text-[#B9915E]" />
                        {svc.name}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                          isConfigured
                            ? 'bg-[#2ea043]/15 text-[#3fb950] border border-[#2ea043]/30'
                            : 'bg-[#181914] text-[#A5A69D] border border-[#292A23]'
                        }`}
                      >
                        {svc.status}
                      </span>
                    </div>

                    <p className="text-[11px] text-[#A5A69D] leading-snug break-words font-mono">
                      {svc.detail}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-[#12130F] border border-[#292A23] text-xs font-mono text-[#A5A69D]">
              Awaiting dependency telemetry from GET /api/v1/health/dependencies...
            </div>
          )}
        </div>

        {/* 4. FOUR SUPPORTED ANSWER OUTCOMES CONTRACT */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono uppercase tracking-wider text-[#A5A69D] font-bold">
              Available Query Outcomes & Protocol Responses
            </span>
            <div className="h-px bg-[#292A23] flex-1" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
            {/* Outcome 1: Full Answer */}
            <div className="p-4 rounded-xl bg-[#12130F] border border-[#2ea043]/30 space-y-2 shadow-sm">
              <div className="flex items-center gap-2 text-[#3fb950] font-bold">
                <CheckCircle2 className="w-4 h-4 text-[#3fb950]" />
                <span>Full Answer</span>
              </div>
              <p className="text-[#A5A69D] leading-relaxed font-sans text-xs">
                Verified decision path with quoted verbatim rationale surviving quote check. High confidence score.
              </p>
            </div>

            {/* Outcome 2: Partial Answer */}
            <div className="p-4 rounded-xl bg-[#12130F] border border-[#d29922]/30 space-y-2 shadow-sm">
              <div className="flex items-center gap-2 text-[#e3b341] font-bold">
                <HelpCircle className="w-4 h-4 text-[#e3b341]" />
                <span>Partial Answer</span>
              </div>
              <p className="text-[#A5A69D] leading-relaxed font-sans text-xs">
                Change recorded in history, rationale missing or unquoted (<code className="bg-[#080907] border border-[#292A23] px-1 py-0.5 rounded text-[#e3b341]">no_verified_quote</code>). Enumerates gaps.
              </p>
            </div>

            {/* Outcome 3: Refusal */}
            <div className="p-4 rounded-xl bg-[#12130F] border border-[#292A23] space-y-2 shadow-sm">
              <div className="flex items-center gap-2 text-[#F5F3ED] font-bold">
                <XCircle className="w-4 h-4 text-[#8C806F]" />
                <span>Calibrated Refusal</span>
              </div>
              <p className="text-[#A5A69D] leading-relaxed font-sans text-xs">
                Truthful refusal (<code className="bg-[#080907] border border-[#292A23] px-1 py-0.5 rounded text-[#8C806F]">no_decision_path</code>, <code className="bg-[#080907] border border-[#292A23] px-1 py-0.5 rounded text-[#8C806F]">entity_not_found</code>, <code className="bg-[#080907] border border-[#292A23] px-1 py-0.5 rounded text-[#8C806F]">out_of_scope</code>).
              </p>
            </div>

            {/* Outcome 4: Ambiguous Entity */}
            <div className="p-4 rounded-xl bg-[#12130F] border border-[#B9915E]/30 space-y-2 shadow-sm">
              <div className="flex items-center gap-2 text-[#B9915E] font-bold">
                <Box className="w-4 h-4 text-[#B9915E]" />
                <span>Ambiguous Entity</span>
              </div>
              <p className="text-[#A5A69D] leading-relaxed font-sans text-xs">
                Matches multiple files or keys. Returns candidate chips for immediate disambiguation.
              </p>
            </div>
          </div>
        </div>

        {/* 5. REPOSITORY METADATA & TIMESTAMPS (Only when returned) */}
        <div className="p-5 rounded-xl bg-[#12130F] border border-[#292A23] space-y-3 text-xs font-mono shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#F5F3ED] uppercase tracking-wider">
              Repository Specification Record
            </span>
            {repoData?.fixture && (
              <span className="px-2 py-0.5 rounded bg-[#d29922]/15 text-[#e3b341] border border-[#d29922]/30 text-[10px]">
                Synthetic Benchmark Fixture
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-[#A5A69D]">
            <div>
              <span className="text-[10px] text-[#A5A69D] block uppercase">Repository ID</span>
              <span className="text-[#F5F3ED] font-bold">{repoData?.id || repoId}</span>
            </div>
            <div>
              <span className="text-[10px] text-[#A5A69D] block uppercase">Name</span>
              <span className="text-[#F5F3ED] font-bold">{repoData?.name || repoId}</span>
            </div>
            {repoData?.full_name && (
              <div>
                <span className="text-[10px] text-[#A5A69D] block uppercase">Full Name</span>
                <span className="text-[#F5F3ED] font-bold">{repoData.full_name}</span>
              </div>
            )}
            {repoData?.owner && (
              <div>
                <span className="text-[10px] text-[#A5A69D] block uppercase">Owner</span>
                <span className="text-[#F5F3ED] font-bold">{repoData.owner}</span>
              </div>
            )}
            {repoData?.scope && (
              <div>
                <span className="text-[10px] text-[#A5A69D] block uppercase">Scope</span>
                <span className="text-[#F5F3ED] font-bold">{repoData.scope}</span>
              </div>
            )}
            {repoData?.url && (
              <div>
                <span className="text-[10px] text-[#A5A69D] block uppercase">Source URL</span>
                <a
                  href={repoData.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#757F6C] hover:text-[#AFD2FA] font-bold truncate block underline transition-colors"
                >
                  {repoData.url}
                </a>
              </div>
            )}
            {repoData?.last_rebuilt_at && (
              <div>
                <span className="text-[10px] text-[#A5A69D] block uppercase">Last Rebuilt Timestamp</span>
                <span className="text-[#B9915E] font-bold">
                  {new Date(repoData.last_rebuilt_at).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

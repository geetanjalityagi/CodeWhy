import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
  Handle,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  Repository,
  GraphResponse,
  GraphNode as RawGraphNode,
  Entity,
  QuestionContext,
} from '../types';
import {
  fetchRepositoryGraphResult,
  fetchEntitySearch,
  type GraphFetchResult,
} from '../services/api';
import { DecisionDrawer } from './DecisionDrawer';
import {
  GitFork,
  Layers,
  Search,
  Filter,
  X,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  RotateCcw,
  FileCode,
  Folder,
  Key,
  GitCommit,
  GitPullRequest,
  User,
  FileText,
  AlertTriangle,
  Table,
  Workflow,
  Eye,
  EyeOff,
  Database,
  GitBranch,
  Loader2,
} from 'lucide-react';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 136;
const NODE_SPACING = 380;
const RADIAL_SPACING = 420;

function radialNodePositions(
  nodes: RawGraphNode[],
  edges: GraphResponse['edges'],
  focusId?: string | null,
): Map<string, { x: number; y: number }> {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const degree = (id: string) => adjacency.get(id)?.size ?? 0;
  const rootNode = nodes.find((node) => node.id === focusId)
    ?? [...nodes].sort((a, b) => degree(b.id) - degree(a.id) || a.id.localeCompare(b.id))[0];
  if (!rootNode) return new Map();
  const rootId = rootNode.id;
  const levels = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (levels.has(neighbor)) continue;
      levels.set(neighbor, (levels.get(nodeId) ?? 0) + 1);
      queue.push(neighbor);
    }
  }

  const maxLevel = Math.max(0, ...levels.values());
  for (const node of nodes) {
    if (!levels.has(node.id)) levels.set(node.id, maxLevel + 1);
  }

  const rings = new Map<number, RawGraphNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    const ring = rings.get(level) ?? [];
    ring.push(node);
    rings.set(level, ring);
  }

  const positions = new Map<string, { x: number; y: number }>([
    [rootId, { x: -NODE_WIDTH / 2, y: -NODE_HEIGHT / 2 }],
  ]);
  for (const [level, ring] of rings) {
    if (level === 0) continue;
    ring.sort((a, b) => degree(b.id) - degree(a.id) || a.id.localeCompare(b.id));
    const radius = Math.max(RADIAL_SPACING * level, ring.length * NODE_SPACING / (2 * Math.PI));
    const offset = (level % 2) * Math.PI / Math.max(ring.length, 1);
    ring.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / ring.length + offset;
      positions.set(node.id, {
        x: Math.cos(angle) * radius - NODE_WIDTH / 2,
        y: Math.sin(angle) * radius - NODE_HEIGHT / 2,
      });
    });
  }
  return positions;
}

// Custom Node Data
interface CustomNodeData extends Record<string, unknown> {
  raw: RawGraphNode;
  isSelected: boolean;
  isFocus: boolean;
  onSelect: (node: RawGraphNode) => void;
  onOpenDecision?: (decisionId: string) => void;
}

// Custom React Flow Node Component
const CodeWhyGraphNode: React.FC<NodeProps<Node<CustomNodeData>>> = ({ data, selected }) => {
  const node = data.raw;
  const isSelected = selected || data.isSelected;

  // Render node icon and styling according to type and decision state
  const renderVisuals = () => {
    switch (node.type) {
      case 'Decision': {
        const state = (node.props?.state || 'ACTIVE').toUpperCase();
        const badgeText = state === 'ACTIVE'
          ? 'Active'
          : state === 'SUPERSEDED'
            ? 'Superseded'
            : state === 'REJECTED'
              ? 'Rejected'
              : 'Unresolved';
        const icon = state === 'ACTIVE'
          ? <CheckCircle2 className="w-3.5 h-3.5 text-[#B9915E] shrink-0" />
          : state === 'SUPERSEDED'
            ? <Clock className="w-3.5 h-3.5 text-[#8C806F] shrink-0" />
            : state === 'REJECTED'
              ? <XCircle className="w-3.5 h-3.5 text-[#E06C75] shrink-0" />
              : <HelpCircle className="w-3.5 h-3.5 text-[#B9915E] shrink-0" />;
        return {
          borderColor: isSelected
            ? 'border-[#B9915E] ring-2 ring-[#B9915E]/40'
            : 'border-[#B9915E]/50 hover:border-[#B9915E]',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#B9915E]/15 text-[#B9915E] border-[#B9915E]/30',
          badgeText,
          icon,
          glowColor: 'hover:shadow-[0_0_16px_rgba(185,145,94,0.2)]',
          handleColor: '!bg-[#B9915E] !border-[#12130F]',
        };
      }
      case 'CodeEntity': {
        const entType = node.props?.entity_type || 'File';
        if (entType === 'Module') {
          return {
            borderColor: isSelected
              ? 'border-[#757F6C] ring-2 ring-[#757F6C]/40'
              : 'border-[#757F6C]/50 hover:border-[#757F6C]',
            bg: 'bg-[#12130F]',
            badgeBg: 'bg-[#757F6C]/15 text-[#AFD2FA] border-[#757F6C]/30',
            badgeText: 'Module',
            icon: <Folder className="w-3.5 h-3.5 text-[#757F6C] shrink-0" />,
            glowColor: 'hover:shadow-[0_0_16px_rgba(117,127,108,0.2)]',
            handleColor: '!bg-[#757F6C] !border-[#12130F]',
          };
        }
        if (entType === 'ConfigKey') {
          return {
            borderColor: isSelected
              ? 'border-[#8C806F] ring-2 ring-[#8C806F]/40'
              : 'border-[#8C806F]/50 hover:border-[#8C806F]',
            bg: 'bg-[#12130F]',
            badgeBg: 'bg-[#8C806F]/15 text-[#F5F3ED] border-[#8C806F]/30',
            badgeText: 'ConfigKey',
            icon: <Key className="w-3.5 h-3.5 text-[#8C806F] shrink-0" />,
            glowColor: 'hover:shadow-[0_0_16px_rgba(140,128,111,0.2)]',
            handleColor: '!bg-[#8C806F] !border-[#12130F]',
          };
        }
        return {
          borderColor: isSelected
            ? 'border-[#757F6C] ring-2 ring-[#757F6C]/40'
            : 'border-[#757F6C]/50 hover:border-[#757F6C]',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#757F6C]/15 text-[#F5F3ED] border-[#757F6C]/30',
          badgeText: 'File',
          icon: <FileCode className="w-3.5 h-3.5 text-[#757F6C] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(117,127,108,0.2)]',
          handleColor: '!bg-[#757F6C] !border-[#12130F]',
        };
      }
      case 'Commit':
        return {
          borderColor: isSelected
            ? 'border-[#E06C75] ring-2 ring-[#E06C75]/40'
            : 'border-[#E06C75]/40 hover:border-[#E06C75]',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#E06C75]/15 text-[#E06C75] border-[#E06C75]/30',
          badgeText: 'Commit',
          icon: <GitCommit className="w-3.5 h-3.5 text-[#E06C75] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(224,108,117,0.2)]',
          handleColor: '!bg-[#E06C75] !border-[#12130F]',
        };
      case 'Repository':
        return {
          borderColor: isSelected
            ? 'border-[#B9915E] ring-2 ring-[#B9915E]/40'
            : 'border-[#B9915E]/50 hover:border-[#B9915E]',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#B9915E]/15 text-[#B9915E] border-[#B9915E]/30',
          badgeText: 'Repository',
          icon: <GitBranch className="w-3.5 h-3.5 text-[#B9915E] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(185,145,94,0.2)]',
          handleColor: '!bg-[#B9915E] !border-[#12130F]',
        };
      case 'PullRequest':
        return {
          borderColor: isSelected
            ? 'border-[#AFD2FA] ring-2 ring-[#AFD2FA]/40'
            : 'border-[#AFD2FA]/40 hover:border-[#AFD2FA]',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#AFD2FA]/15 text-[#AFD2FA] border-[#AFD2FA]/30',
          badgeText: node.props?.merged === false ? 'PR (Open)' : 'PR',
          icon: <GitPullRequest className="w-3.5 h-3.5 text-[#AFD2FA] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(175,210,250,0.2)]',
          handleColor: '!bg-[#AFD2FA] !border-[#12130F]',
        };
      case 'Evidence':
        return {
          borderColor: isSelected
            ? 'border-[#757F6C] ring-2 ring-[#757F6C]/40'
            : 'border-[#292A23] hover:border-[#757F6C]/60',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#292A23] text-[#A5A69D] border-[#292A23]',
          badgeText: 'Evidence',
          icon: <FileText className="w-3.5 h-3.5 text-[#A5A69D] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(117,127,108,0.15)]',
          handleColor: '!bg-[#757F6C] !border-[#12130F]',
        };
      case 'Person':
        return {
          borderColor: isSelected
            ? 'border-[#AFD2FA] ring-2 ring-[#AFD2FA]/40'
            : 'border-[#292A23] hover:border-[#AFD2FA]/60',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#AFD2FA]/15 text-[#AFD2FA] border-[#AFD2FA]/30',
          badgeText: 'Person',
          icon: <User className="w-3.5 h-3.5 text-[#AFD2FA] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(175,210,250,0.2)]',
          handleColor: '!bg-[#AFD2FA] !border-[#12130F]',
        };
      default:
        return {
          borderColor: isSelected
            ? 'border-[#757F6C] ring-2 ring-[#757F6C]/40'
            : 'border-[#292A23] hover:border-[#757F6C]',
          bg: 'bg-[#12130F]',
          badgeBg: 'bg-[#292A23] text-[#A5A69D] border-[#292A23]',
          badgeText: node.type,
          icon: <Workflow className="w-3.5 h-3.5 text-[#A5A69D] shrink-0" />,
          glowColor: 'hover:shadow-[0_0_16px_rgba(117,127,108,0.15)]',
          handleColor: '!bg-[#757F6C] !border-[#12130F]',
        };
    }
  };

  const style = renderVisuals();

  return (
    <div
      onClick={() => data.onSelect(node)}
      className={`w-[280px] min-h-[136px] px-4 py-3 rounded-xl border ${style.borderColor} ${style.bg} ${style.glowColor} shadow-xl transition-all duration-150 cursor-pointer select-none group text-left ${data.isFocus ? 'ring-2 ring-[#B9915E] shadow-[0_0_24px_rgba(185,145,94,0.35)]' : ''}`}
    >
      <Handle type="target" position={Position.Left} className={`!w-2.5 !h-2.5 !border-2 ${style.handleColor}`} />
      
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md border font-semibold flex items-center gap-1.5 ${style.badgeBg}`}>
          {style.icon}
          <span>{style.badgeText}</span>
        </span>

        {data.isFocus ? (
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-[#B9915E] bg-[#B9915E]/15 border border-[#B9915E]/40 rounded px-1.5 py-0.5 shadow-[0_0_10px_rgba(185,145,94,0.2)]">
            Focus
          </span>
        ) : (
          <span className="text-[10px] font-mono text-[#A5A69D]/80 truncate max-w-[100px]" title={node.id}>
            {node.id.replace(/^(dec_|file:|key:|module:|person:|pr:|ev:)/, '')}
          </span>
        )}
      </div>

      <div className="text-sm font-semibold font-mono text-[#F5F3ED] leading-snug break-words line-clamp-2 group-hover:text-[#B9915E] transition-colors" title={node.label}>
        {node.label}
      </div>

      {node.props?.path && (
        <div className="text-[11px] font-mono text-[#A5A69D] break-all line-clamp-2 mt-1" title={node.props.path}>
          {node.props.path}
        </div>
      )}

      {node.props?.rule && (
        <div className="mt-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#1A1813] text-[#B9915E] border border-[#B9915E]/30 truncate inline-block">
          Rule: {node.props.rule}
        </div>
      )}

      <Handle type="source" position={Position.Right} className={`!w-2.5 !h-2.5 !border-2 ${style.handleColor}`} />
    </div>
  );
};

const nodeTypes = {
  customNode: CodeWhyGraphNode,
};

interface GraphExplorerViewProps {
  selectedRepo: Repository | null;
  questionContext: QuestionContext | null;
  onAskQuestion: () => void;
}

export const GraphExplorerView: React.FC<GraphExplorerViewProps> = ({
  selectedRepo,
  questionContext,
  onAskQuestion,
}) => {
  const [graphData, setGraphData] = useState<GraphResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isGraphOffline, setIsGraphOffline] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Focused entity for a bounded subgraph; null shows the whole repository graph.
  const [focusEntityId, setFocusEntityId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Search input for entities
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<Entity[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);

  // View mode: Visual Graph vs Accessible List View
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');

  // Selected node for detail drawer/panel
  const [selectedNode, setSelectedNode] = useState<RawGraphNode | null>(null);
  const [activeDecisionDrawerId, setActiveDecisionDrawerId] = useState<string | null>(null);

  // Filters (Evidence and Person hidden by default as specified!)
  const [filters, setFilters] = useState({
    Repository: true,
    CodeEntity: true,
    Decision: true,
    PullRequest: true,
    Evidence: false, // Hidden by default
    Person: false,   // Hidden by default
  });

  // Simulated test states toggle
  const [simulateOffline, setSimulateOffline] = useState(false);
  const [simulateTruncated, setSimulateTruncated] = useState(false);

  // Resolve active repo ID
  const urlMatch = typeof window !== 'undefined'
    ? window.location.pathname.match(/\/r\/([^/]+)/)
    : null;
  const repoId = selectedRepo?.id || (urlMatch ? decodeURIComponent(urlMatch[1]) : '');
  const activeQuestion = questionContext?.repositoryId === repoId ? questionContext : null;
  const questionEntityId = activeQuestion?.response.entity?.id ?? null;

  // A new question moves the focus to its entity; a repo switch clears it.
  useEffect(() => {
    setFocusEntityId(questionEntityId);
    setSelectedNode(null);
  }, [questionEntityId, repoId]);

  // Load graph data
  const loadGraph = useCallback(async (targetRepoId: string, focalEntity?: string | null) => {
    setIsLoading(true);
    setErrorMessage(null);

    // If simulated offline
    if (simulateOffline) {
      setIsGraphOffline(true);
      setIsLoading(false);
      return;
    }

    const result: GraphFetchResult = await fetchRepositoryGraphResult(targetRepoId, focalEntity || undefined);

    if (result.status === 'offline') {
      setIsGraphOffline(true);
      setGraphData(null);
    } else if (result.status === 'not_found') {
      setIsGraphOffline(false);
      setErrorMessage(`Repository or entity not found in graph`);
      setGraphData(null);
    } else if (result.status === 'error') {
      setIsGraphOffline(false);
      setErrorMessage(result.message);
      setGraphData(null);
    } else {
      setIsGraphOffline(false);
      let data = result.data;
      if (simulateTruncated) {
        data = { ...data, truncated: true };
      }
      setGraphData(data);
    }

    setIsLoading(false);
  }, [simulateOffline, simulateTruncated]);

  // Load the focused subgraph, or the repo-wide graph when nothing is focused.
  useEffect(() => {
    if (!repoId) {
      setGraphData(null);
      setIsGraphOffline(false);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }
    loadGraph(repoId, focusEntityId);
  }, [repoId, focusEntityId, reloadToken, loadGraph]);

  // Debounced search for entities via GET /api/v1/repositories/{id}/entities?q=...
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 1) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      const res = await fetchEntitySearch(repoId, searchQuery.trim());
      if (res && res.entities) {
        setSearchResults(res.entities);
      } else {
        setSearchResults([]);
      }
      setIsSearching(false);
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, repoId]);

  // Filter nodes based on node-type checkboxes
  const visibleNodesList = useMemo(() => {
    if (!graphData?.nodes) return [];
    return graphData.nodes.filter((node) => {
      const typeKey = node.type as keyof typeof filters;
      if (filters[typeKey] !== undefined) {
        return filters[typeKey];
      }
      return true;
    });
  }, [graphData, filters]);

  const visibleNodeIds = useMemo(() => {
    return new Set(visibleNodesList.map((n) => n.id));
  }, [visibleNodesList]);

  // Filter edges: only connect between currently visible nodes!
  const visibleEdgesList = useMemo(() => {
    if (!graphData?.edges) return [];
    return graphData.edges.filter(
      (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
    );
  }, [graphData, visibleNodeIds]);

  // Place the focus entity at the center and connected nodes in relationship rings.
  const { layoutNodes, layoutEdges } = useMemo(() => {
    if (visibleNodesList.length === 0) {
      return { layoutNodes: [], layoutEdges: [] };
    }

    const sortedNodes = [...visibleNodesList].sort((a, b) => a.id.localeCompare(b.id));
    const sortedEdges = [...visibleEdgesList].sort((a, b) =>
      `${a.source}->${a.target}:${a.type}`.localeCompare(`${b.source}->${b.target}:${b.type}`)
    );
    const positions = radialNodePositions(sortedNodes, sortedEdges, focusEntityId);

    const rfNodes: Node<CustomNodeData>[] = sortedNodes.map((node) => {
      return {
        id: node.id,
        type: 'customNode',
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          raw: node,
          isSelected: selectedNode?.id === node.id,
          isFocus: node.id === focusEntityId,
          onSelect: (n) => setSelectedNode(n),
          onOpenDecision: (decId) => setActiveDecisionDrawerId(decId),
        },
      };
    });

    const rfEdges: Edge[] = sortedEdges.map((edge, idx) => {
      let strokeColor = '#8C806F';
      let isDashed = false;

      if (edge.type === 'SUPERSEDES') {
        strokeColor = '#B9915E'; // dashed bronze
        isDashed = true;
      } else if (edge.type === 'GOVERNS') {
        strokeColor = '#757F6C'; // muted olive/green
      } else if (edge.type === 'DECIDED_IN') {
        strokeColor = '#E06C75'; // restrained warm coral/red
      } else if (edge.type === 'SUPPORTED_BY') {
        strokeColor = '#757F6C';
      } else if (edge.type === 'AUTHORED' || edge.type === 'REVIEWED') {
        strokeColor = '#AFD2FA'; // powder blue
      } else if (edge.type === 'REFERENCES') {
        strokeColor = '#8C806F'; // muted gray/taupe
      }

      const edgeLabel = edge.rule ? `${edge.type} (${edge.rule})` : edge.type;

      return {
        id: `e-${edge.source}-${edge.target}-${idx}`,
        source: edge.source,
        target: edge.target,
        type: 'default',
        animated: edge.type === 'SUPERSEDES',
        label: edgeLabel,
        labelStyle: {
          fill: '#F5F3ED',
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
        },
        labelBgStyle: {
          fill: '#12130F',
          fillOpacity: 0.95,
        },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        style: {
          stroke: strokeColor,
          strokeWidth: isDashed ? 2 : 1.75,
          strokeDasharray: isDashed ? '5,5' : undefined,
          opacity: 0.85,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: strokeColor,
        },
      };
    });

    return { layoutNodes: rfNodes, layoutEdges: rfEdges };
  }, [visibleNodesList, visibleEdgesList, selectedNode, focusEntityId]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CustomNodeData>>(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(layoutEdges);

  // Sync React Flow nodes/edges when layout updates
  useEffect(() => {
    setNodes(layoutNodes);
    setEdges(layoutEdges);
  }, [layoutNodes, layoutEdges, setNodes, setEdges]);

  // Toggle filter
  const toggleFilter = (key: keyof typeof filters) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Connected edges for the selected node detail panel
  const connectedDetails = useMemo(() => {
    if (!selectedNode || !graphData?.edges) return { inbound: [], outbound: [] };
    const inbound = graphData.edges.filter((e) => e.target === selectedNode.id);
    const outbound = graphData.edges.filter((e) => e.source === selectedNode.id);
    return { inbound, outbound };
  }, [selectedNode, graphData]);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] min-h-[600px] bg-[#080907] w-full text-[#F5F3ED] overflow-hidden select-none">
      
      {/* Top Header & Context Bar */}
      <div className="border-b border-[#292A23] bg-[#0B0C09]/95 backdrop-blur-md px-4 sm:px-6 py-3.5 shrink-0 z-20">
        <div className="flex flex-wrap items-center justify-between gap-4">
          
          {/* Left: Breadcrumbs & Title */}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#12130F] text-[#B9915E] border border-[#292A23] shadow-sm">
              <GitFork className="w-4 h-4" />
            </div>

            <div>
              {focusEntityId && (
                <div className="flex items-center gap-2 text-xs font-mono text-[#B9915E] font-semibold mb-0.5">
                  <span className="text-[#A5A69D] text-[10px] uppercase tracking-wider">focus:</span>
                  <code className="text-[#F5F3ED] bg-[#12130F] px-1.5 py-0.5 rounded border border-[#292A23]">{focusEntityId}</code>
                </div>
              )}
              <h1 className="text-lg font-bold font-sans text-[#F5F3ED] tracking-tight flex items-center gap-2.5 pt-0.5">
                <span>Connected Knowledge Graph</span>
                {isLoading ? (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#757F6C]/15 text-[#757F6C] border border-[#757F6C]/30 animate-pulse">
                    Loading graph...
                  </span>
                ) : graphData ? (
                  <span className="text-xs font-mono px-2.5 py-0.5 rounded-full bg-[#12130F] border border-[#292A23] text-[#A5A69D]">
                    {visibleNodesList.length} of {graphData.nodes.length} nodes visible
                  </span>
                ) : null}
              </h1>
            </div>
          </div>

          {/* Center: Search Entities autocomplete (GET /api/v1/repositories/{id}/entities) */}
          <div className="relative w-full sm:w-72 lg:w-96">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#B9915E] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setIsSearchOpen(true);
                }}
                onFocus={() => setIsSearchOpen(true)}
                placeholder="Search entities (e.g. retry, config)..."
                className="w-full pl-8 pr-8 py-1.5 rounded-xl bg-[#12130F] border border-[#292A23] text-xs font-mono text-[#F5F3ED] placeholder:text-[#A5A69D]/60 focus:outline-none focus:border-[#B9915E] transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setSearchResults([]);
                    setIsSearchOpen(false);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#A5A69D] hover:text-[#F5F3ED]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Dropdown search results */}
            {isSearchOpen && (searchResults.length > 0 || isSearching) && (
              <div className="absolute top-full left-0 right-0 mt-1.5 bg-[#12130F] border border-[#292A23] rounded-xl shadow-2xl overflow-hidden z-50 text-xs font-mono max-h-64 overflow-y-auto">
                <div className="px-3 py-1.5 border-b border-[#292A23] text-[10px] text-[#A5A69D] uppercase tracking-wider flex items-center justify-between">
                  <span>Candidate Entities</span>
                  {isSearching && <span className="text-[#B9915E]">Searching...</span>}
                </div>

                {searchResults.map((ent) => (
                  <button
                    key={ent.id}
                    onClick={() => {
                      setFocusEntityId(ent.id);
                      setIsSearchOpen(false);
                      setSearchQuery('');
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-[#1A1813] flex items-center justify-between border-b border-[#292A23]/60 last:border-0 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 truncate">
                      {ent.type === 'Module' && <Folder className="w-3.5 h-3.5 text-[#AFD2FA] shrink-0" />}
                      {ent.type === 'ConfigKey' && <Key className="w-3.5 h-3.5 text-[#8C806F] shrink-0" />}
                      {ent.type === 'File' && <FileCode className="w-3.5 h-3.5 text-[#757F6C] shrink-0" />}
                      <div className="truncate">
                        <span className="font-semibold text-[#F5F3ED]">{ent.label}</span>
                        {ent.path && <span className="text-[#A5A69D] text-[10px] block truncate">{ent.path}</span>}
                      </div>
                    </div>

                    <span className="text-[10px] px-2 py-0.5 rounded bg-[#B9915E]/15 text-[#B9915E] border border-[#B9915E]/30 shrink-0">
                      Focus Subgraph
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right: Controls & Navigation */}
          <div className="flex items-center gap-2">
            
            {/* View Mode Switcher */}
            <div className="flex items-center bg-[#12130F] p-1 rounded-xl border border-[#292A23] text-xs font-mono">
              <button
                onClick={() => setViewMode('graph')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'graph'
                    ? 'bg-[#B9915E]/15 text-[#B9915E] font-semibold border border-[#B9915E]/40'
                    : 'text-[#A5A69D] hover:text-[#F5F3ED]'
                }`}
                title="Interactive connected node graph"
              >
                <Workflow className="w-3.5 h-3.5" />
                <span>Visual</span>
              </button>

              <button
                onClick={() => setViewMode('list')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'list'
                    ? 'bg-[#B9915E]/15 text-[#B9915E] font-semibold border border-[#B9915E]/40'
                    : 'text-[#A5A69D] hover:text-[#F5F3ED]'
                }`}
                title="Accessible Screen-Reader Ready List View"
              >
                <Table className="w-3.5 h-3.5" />
                <span>Accessible List</span>
              </button>
            </div>

            {/* Ask about this repository, when no question is loaded */}
            {!activeQuestion && (
              <button
                onClick={onAskQuestion}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#12130F] hover:bg-[#1A1813] text-[#A5A69D] hover:text-[#F5F3ED] border border-[#292A23] text-xs font-mono transition-colors cursor-pointer"
                title="Open the workspace to ask a question"
              >
                <Search className="w-3 h-3" />
                <span>Ask a question</span>
              </button>
            )}

            {/* Clear Entity Focus Button */}
            {focusEntityId && focusEntityId !== questionEntityId && (
              <button
                onClick={() => setFocusEntityId(questionEntityId)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#12130F] hover:bg-[#1A1813] text-[#B9915E] border border-[#B9915E]/35 text-xs font-mono transition-colors cursor-pointer"
                title={questionEntityId ? 'Return to the entity from the latest question' : 'Return to the full repository graph'}
              >
                <RotateCcw className="w-3 h-3" />
                <span>{questionEntityId ? 'Question Entity' : 'Full Graph'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Node Type Filter Chips Bar */}
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-[#292A23] mt-3 text-xs font-mono">
          <span className="text-[10px] text-[#A5A69D] uppercase tracking-wider flex items-center gap-1 mr-1">
            <Filter className="w-3 h-3 text-[#B9915E]" /> Filters:
          </span>

          {/* Repository */}
          <button
            onClick={() => toggleFilter('Repository')}
            className={`px-2.5 py-0.5 rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer text-xs ${
              filters.Repository
                ? 'bg-[#B9915E]/15 text-[#B9915E] border-[#B9915E]/40 font-semibold'
                : 'bg-[#12130F] text-[#A5A69D]/60 border-[#292A23] opacity-60'
            }`}
          >
            <GitBranch className="w-3 h-3 text-[#B9915E]" />
            <span>Repository</span>
          </button>

          {/* CodeEntity */}
          <button
            onClick={() => toggleFilter('CodeEntity')}
            className={`px-2.5 py-0.5 rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer text-xs ${
              filters.CodeEntity
                ? 'bg-[#757F6C]/20 text-[#757F6C] border-[#757F6C]/40 font-semibold'
                : 'bg-[#12130F] text-[#A5A69D]/60 border-[#292A23] opacity-60'
            }`}
          >
            <FileCode className="w-3 h-3 text-[#757F6C]" />
            <span>Entities (File/Module/Key)</span>
          </button>

          {/* Decision */}
          <button
            onClick={() => toggleFilter('Decision')}
            className={`px-2.5 py-0.5 rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer text-xs ${
              filters.Decision
                ? 'bg-[#B9915E]/15 text-[#B9915E] border-[#B9915E]/40 font-semibold'
                : 'bg-[#12130F] text-[#A5A69D]/60 border-[#292A23] opacity-60'
            }`}
          >
            <CheckCircle2 className="w-3 h-3 text-[#B9915E]" />
            <span>Decisions</span>
          </button>

          {/* PullRequest */}
          <button
            onClick={() => toggleFilter('PullRequest')}
            className={`px-2.5 py-0.5 rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer text-xs ${
              filters.PullRequest
                ? 'bg-[#AFD2FA]/15 text-[#AFD2FA] border-[#AFD2FA]/40 font-semibold'
                : 'bg-[#12130F] text-[#A5A69D]/60 border-[#292A23] opacity-60'
            }`}
          >
            <GitPullRequest className="w-3 h-3 text-[#AFD2FA]" />
            <span>Pull Requests</span>
          </button>

          {/* Evidence (Hidden by default) */}
          <button
            onClick={() => toggleFilter('Evidence')}
            className={`px-2.5 py-0.5 rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer text-xs ${
              filters.Evidence
                ? 'bg-[#8C806F]/20 text-[#F5F3ED] border-[#8C806F]/40 font-semibold'
                : 'bg-[#12130F] text-[#A5A69D] border-[#292A23]'
            }`}
          >
            {filters.Evidence ? <Eye className="w-3 h-3 text-[#F5F3ED]" /> : <EyeOff className="w-3 h-3 text-[#A5A69D]" />}
            <span>Evidence {filters.Evidence ? '(Shown)' : '(Hidden)'}</span>
          </button>

          {/* Person (Hidden by default) */}
          <button
            onClick={() => toggleFilter('Person')}
            className={`px-2.5 py-0.5 rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer text-xs ${
              filters.Person
                ? 'bg-[#8C806F]/20 text-[#F5F3ED] border-[#8C806F]/40 font-semibold'
                : 'bg-[#12130F] text-[#A5A69D] border-[#292A23]'
            }`}
          >
            {filters.Person ? <Eye className="w-3 h-3 text-[#F5F3ED]" /> : <EyeOff className="w-3 h-3 text-[#A5A69D]" />}
            <span>People {filters.Person ? '(Shown)' : '(Hidden)'}</span>
          </button>

{import.meta.env.DEV && (
          <div className="ml-auto flex items-center gap-2 text-[10px] text-[#A5A69D]">
            <span className="text-[#A5A69D] uppercase">Test States:</span>
            <button
              onClick={() => setSimulateOffline((o) => !o)}
              className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
                simulateOffline
                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 font-bold'
                  : 'bg-[#12130F] text-[#A5A69D] border-[#292A23] hover:text-[#F5F3ED]'
              }`}
            >
              {simulateOffline ? 'Reset Online' : 'Simulate 503'}
            </button>
            <button
              onClick={() => setSimulateTruncated((t) => !t)}
              className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
                simulateTruncated
                  ? 'bg-[#B9915E]/20 text-[#B9915E] border-[#B9915E]/40 font-bold'
                  : 'bg-[#12130F] text-[#A5A69D] border-[#292A23] hover:text-[#F5F3ED]'
              }`}
            >
              {simulateTruncated ? 'Reset Ceiling' : 'Simulate Truncated'}
            </button>
          </div>
        )}
        </div>
      </div>

      {/* Truncated Subgraph Notice Banner */}
      {graphData?.truncated && (
        <div className="bg-[#1A1813] border-b border-[#B9915E]/30 px-4 py-2 flex items-center justify-between text-xs font-mono text-[#B9915E] z-10 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[#B9915E] shrink-0" />
            <span>
              <strong>Truncated Response Notice:</strong> Graph query reached the hard node budget (maximum 80 nodes returned). Some entities or temporal supersessions may not be displayed.
            </span>
          </div>
          <span className="text-[11px] text-[#A5A69D] hidden sm:inline">
            Focus on an entity using the search bar to inspect focused subgraphs.
          </span>
        </div>
      )}

      {activeQuestion && (
        <div className="shrink-0 border-b border-[#292A23] bg-[#0B0C09]/90 px-4 py-2.5">
          <p className="text-[10px] font-mono uppercase tracking-wider text-[#B9915E] font-semibold">Graph for latest question</p>
          <p className="mt-0.5 truncate text-xs font-mono text-[#F5F3ED]">{activeQuestion.question}</p>
        </div>
      )}

      {!isGraphOffline && !errorMessage && viewMode === 'graph' && graphData && (
        <div className="shrink-0 border-b border-[#292A23] bg-[#0B0C09]/90 px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] font-mono text-[#A5A69D]">
            <span className="uppercase font-bold tracking-wider text-[#F5F3ED]">Legend</span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#B9915E]" />
              Decision
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#757F6C]" />
              Source File
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#E06C75]" />
              Commit
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#AFD2FA]" />
              Author
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#AFD2FA]" />
              Pull Request
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed border-[#B9915E]" />
              SUPERSEDES
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-[#757F6C]" />
              GOVERNS
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-[#E06C75]" />
              DECIDED_IN
            </span>
          </div>
        </div>
      )}

      {/* Main Content Area: Visual Graph or Accessible List or 503 Offline State */}
      <div className="flex-1 min-h-0 relative flex overflow-hidden">
        
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center z-10 space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-[#757F6C]" />
            <p className="text-xs font-mono text-[#A5A69D]">
              Loading {focusEntityId ? 'focused subgraph' : 'repository graph'}...
            </p>
          </div>
        ) : isGraphOffline ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center z-10 space-y-4">
            <div className="p-4 rounded-2xl bg-[#12130F] text-[#E06C75] border border-[#E06C75]/30 shadow-lg">
              <Database className="w-10 h-10" />
            </div>

            <div className="max-w-md space-y-2">
              <div className="inline-block px-2.5 py-0.5 rounded-full bg-[#E06C75]/15 text-[#E06C75] border border-[#E06C75]/30 text-xs font-mono font-bold">
                HTTP 503 • Graph Service Offline
              </div>
              <h2 className="text-xl font-bold font-sans text-[#F5F3ED]">
                Graph Database Engine Unavailable
              </h2>
              <p className="text-xs font-mono text-[#A5A69D] leading-relaxed">
                The graph query service (Neo4j) is currently offline, unconfigured, or unreachable. 
                CodeWhy's local SQLite store remains 100% operational for questions and decision timelines.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2 text-xs font-mono">
              <button
                onClick={() => {
                  setSimulateOffline(false);
                  setReloadToken((token) => token + 1);
                }}
                className="px-4 py-2 rounded-xl bg-[#12130F] hover:bg-[#1A1813] text-[#757F6C] border border-[#757F6C]/40 font-semibold transition-colors flex items-center gap-2 cursor-pointer shadow-sm"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retry Connection</span>
              </button>
            </div>
          </div>
        ) : errorMessage ? (
          /* Error State */
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center z-10 space-y-3">
            <AlertTriangle className="w-8 h-8 text-[#B9915E]" />
            <h3 className="text-sm font-bold text-[#F5F3ED] font-mono">{errorMessage}</h3>
            <button
              onClick={() => {
                setFocusEntityId(null);
                setReloadToken((token) => token + 1);
              }}
              className="px-3 py-1.5 rounded-xl bg-[#12130F] text-[#A5A69D] border border-[#292A23] text-xs font-mono hover:text-[#F5F3ED]"
            >
              Return to Full Graph
            </button>
          </div>
        ) : !graphData ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center z-10 space-y-3">
            <GitFork className="w-8 h-8 text-[#8C806F]" />
            <h3 className="text-sm font-bold text-[#F5F3ED] font-mono">No graph data returned</h3>
            <p className="text-xs font-mono text-[#A5A69D] max-w-md">
              This repository returned no nodes. Search for an entity, or reload the graph.
            </p>
            <button
              onClick={() => setReloadToken((token) => token + 1)}
              className="px-3 py-1.5 rounded-xl bg-[#12130F] text-[#A5A69D] border border-[#292A23] text-xs font-mono hover:text-[#F5F3ED]"
            >
              Reload Graph
            </button>
          </div>
        ) : viewMode === 'list' ? (
          /* 2. Accessible Screen-Reader Friendly List View */
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 w-full max-w-7xl mx-auto space-y-6">
            <div className="flex items-center justify-between border-b border-[#292A23] pb-3">
              <div>
                <h2 className="text-sm font-mono font-bold uppercase text-[#F5F3ED] tracking-wider">
                  Accessible Node & Relationship View
                </h2>
                <p className="text-xs text-[#A5A69D] font-mono">
                  Tabular screen-reader accessible inventory of {visibleNodesList.length} visible graph nodes and {visibleEdgesList.length} relationships
                </p>
              </div>

              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#B9915E]/15 text-[#B9915E] border border-[#B9915E]/30">
                ARIA Accessible
              </span>
            </div>

            <div className="rounded-xl border border-[#292A23] bg-[#12130F] overflow-hidden text-xs font-mono">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#292A23] bg-[#0B0C09] text-[#A5A69D] text-[11px] uppercase tracking-wider">
                    <th className="py-3 px-4">Node Label & ID</th>
                    <th className="py-3 px-4">Type</th>
                    <th className="py-3 px-4">State / Property</th>
                    <th className="py-3 px-4">Connections</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292A23] text-[#A5A69D]">
                  {visibleNodesList.map((node) => {
                    const inCount = graphData?.edges.filter((e) => e.target === node.id).length || 0;
                    const outCount = graphData?.edges.filter((e) => e.source === node.id).length || 0;
                    return (
                      <tr key={node.id} className="hover:bg-[#1A1813]/60 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-bold text-[#F5F3ED]">{node.label}</div>
                          <div className="text-[10px] text-[#A5A69D]/70">{node.id}</div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded bg-[#1A1813] text-[#F5F3ED] border border-[#292A23] text-[10px]">
                            {node.type}
                            {node.props?.entity_type ? ` (${node.props.entity_type})` : ''}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {node.props?.state && (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                node.props.state === 'ACTIVE'
                                  ? 'bg-[#B9915E]/15 text-[#B9915E] border border-[#B9915E]/40'
                                  : node.props.state === 'SUPERSEDED'
                                  ? 'bg-[#12130F] text-[#8C806F] border border-[#292A23]'
                                  : 'bg-[#E06C75]/15 text-[#E06C75] border border-[#E06C75]/40'
                              }`}
                            >
                              {node.props.state}
                            </span>
                          )}
                          {node.props?.path && (
                            <span className="text-[10px] text-[#A5A69D] block truncate max-w-xs">{node.props.path}</span>
                          )}
                          {node.props?.number && (
                            <span className="text-[10px] text-[#AFD2FA]">PR #{node.props.number}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-[11px] text-[#A5A69D]">
                          {inCount} in • {outCount} out
                        </td>
                        <td className="py-3 px-4 text-right space-x-2">
                          <button
                            onClick={() => setSelectedNode(node)}
                            className="px-2.5 py-1 rounded bg-[#12130F] hover:bg-[#1A1813] text-[#757F6C] border border-[#292A23] hover:border-[#757F6C]/40 text-[10px]"
                          >
                            Inspect
                          </button>
                          {node.type === 'Decision' && (
                            <button
                              onClick={() => setActiveDecisionDrawerId(node.id)}
                              className="px-2.5 py-1 rounded bg-[#B9915E]/15 hover:bg-[#B9915E]/25 text-[#B9915E] border border-[#B9915E]/30 text-[10px]"
                            >
                              Drawer
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* 3. Interactive React Flow Canvas */
          <div className="flex-1 w-full h-full relative">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.08, maxZoom: 1.15 }}
              minZoom={0.25}
              maxZoom={2.5}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              className="bg-[#080907]"
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#292A23" gap={24} size={1} />
              <Controls className="codewhy-flow-controls" />
            </ReactFlow>
          </div>
        )}

        {/* 4. Node Detail Inspector Slide-Over Panel */}
        {selectedNode && (
          <aside className="absolute right-4 top-4 bottom-4 w-80 sm:w-96 max-w-[calc(100%-2rem)] border border-[#292A23] rounded-2xl bg-[#0B0C09]/95 backdrop-blur-xl p-5 overflow-y-auto space-y-5 z-30 flex flex-col justify-between shadow-2xl">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[#292A23] pb-3">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#A5A69D] flex items-center gap-1.5 font-bold">
                  <Workflow className="w-3.5 h-3.5 text-[#B9915E]" />
                  Node Inspection
                </span>
                <button
                  onClick={() => setSelectedNode(null)}
                  className="p-1 rounded-lg hover:bg-[#12130F] text-[#A5A69D] hover:text-[#F5F3ED] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Title & Badge */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#12130F] text-[#F5F3ED] border border-[#292A23]">
                    {selectedNode.type}
                  </span>
                  {selectedNode.props?.state && (
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                        selectedNode.props.state === 'ACTIVE'
                          ? 'bg-[#B9915E]/15 text-[#B9915E] border border-[#B9915E]/40'
                          : selectedNode.props.state === 'SUPERSEDED'
                          ? 'bg-[#12130F] text-[#8C806F] border border-[#292A23]'
                          : 'bg-[#E06C75]/15 text-[#E06C75] border border-[#E06C75]/40'
                      }`}
                    >
                      {selectedNode.props.state}
                    </span>
                  )}
                </div>

                <h3 className="text-sm font-bold font-mono text-[#F5F3ED] leading-snug">
                  {selectedNode.label}
                </h3>
                <div className="text-[11px] font-mono text-[#A5A69D] break-all">
                  ID: <code className="text-[#B9915E]">{selectedNode.id}</code>
                </div>
              </div>

              {/* Properties table */}
              <div className="space-y-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#A5A69D] block font-bold">
                  Returned Properties
                </span>
                <div className="p-3 rounded-xl bg-[#12130F] border border-[#292A23] space-y-1.5 text-xs font-mono">
                  {Object.entries(selectedNode.props || {}).length > 0 ? (
                    Object.entries(selectedNode.props).map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-2 border-b border-[#292A23]/60 pb-1 last:border-0 last:pb-0">
                        <span className="text-[#A5A69D] text-[11px]">{k}:</span>
                        <span className="text-[#F5F3ED] text-right truncate max-w-[180px]" title={String(v)}>
                          {String(v)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <span className="text-[#A5A69D]/60 text-[11px]">No extra properties recorded</span>
                  )}
                </div>
              </div>

              {/* Connected Relationships */}
              <div className="space-y-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[#A5A69D] block font-bold">
                  Relationships ({connectedDetails.inbound.length + connectedDetails.outbound.length})
                </span>

                <div className="space-y-2 max-h-48 overflow-y-auto text-xs font-mono">
                  {connectedDetails.inbound.map((edge, i) => (
                    <div key={`in-${i}`} className="p-2 rounded-lg bg-[#12130F] border border-[#292A23] flex items-center justify-between text-[11px]">
                      <span className="text-[#A5A69D] truncate max-w-[120px]">{edge.source}</span>
                      <span className="text-[#757F6C] font-bold px-1.5 py-0.5 rounded bg-[#757F6C]/15 border border-[#757F6C]/30 text-[9px]">
                        ──({edge.type})──►
                      </span>
                      <span className="text-[#F5F3ED] font-semibold">this</span>
                    </div>
                  ))}

                  {connectedDetails.outbound.map((edge, i) => (
                    <div key={`out-${i}`} className="p-2 rounded-lg bg-[#12130F] border border-[#292A23] flex items-center justify-between text-[11px]">
                      <span className="text-[#F5F3ED] font-semibold">this</span>
                      <span className="text-[#B9915E] font-bold px-1.5 py-0.5 rounded bg-[#B9915E]/15 border border-[#B9915E]/30 text-[9px]">
                        ──({edge.type})──►
                      </span>
                      <span className="text-[#A5A69D] truncate max-w-[120px]">{edge.target}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2 pt-4 border-t border-[#292A23] text-xs font-mono">
              {selectedNode.type === 'Decision' && (
                <button
                  onClick={() => setActiveDecisionDrawerId(selectedNode.id)}
                  className="w-full py-2 px-3 rounded-xl bg-[#B9915E]/15 hover:bg-[#B9915E]/25 text-[#B9915E] border border-[#B9915E]/35 font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-[#B9915E]" />
                  <span>Open Full Decision Drawer</span>
                </button>
              )}

              {selectedNode.type === 'CodeEntity' && (
                <button
                  onClick={() => {
                    setFocusEntityId(selectedNode.id);
                  }}
                  className="w-full py-2 px-3 rounded-xl bg-[#757F6C]/20 hover:bg-[#757F6C]/30 text-[#F5F3ED] border border-[#757F6C]/40 font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                >
                  <Workflow className="w-3.5 h-3.5 text-[#757F6C]" />
                  <span>Focus Subgraph on this Entity</span>
                </button>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Shared Decision Detail Drawer */}
      <DecisionDrawer
        decisionId={activeDecisionDrawerId}
        onClose={() => setActiveDecisionDrawerId(null)}
      />
    </div>
  );
};

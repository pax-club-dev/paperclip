import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
  MarkerType,
  Position,
  Handle,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import {
  Search,
  X,
  AlertTriangle,
  ArrowUp,
  Minus,
  ArrowDown,
  ExternalLink,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { issuesApi, type DependencyGraphNode } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useNavigate } from "@/lib/router";
import { Skeleton } from "@/components/ui/skeleton";

// ── Status color mapping for nodes ──────────────────────────────────────────

const STATUS_COLORS: Record<string, { border: string; bg: string; bar: string }> = {
  blocked: { border: "#EF4444", bg: "rgba(239,68,68,0.05)", bar: "#EF4444" },
  in_progress: { border: "#3B82F6", bg: "rgba(59,130,246,0.05)", bar: "#3B82F6" },
  in_review: { border: "#F59E0B", bg: "rgba(245,158,11,0.05)", bar: "#F59E0B" },
  done: { border: "#22C55E", bg: "rgba(34,197,94,0.05)", bar: "#22C55E" },
  todo: { border: "#9CA3AF", bg: "rgba(156,163,175,0.05)", bar: "#9CA3AF" },
  backlog: { border: "#D1D5DB", bg: "rgba(209,213,219,0.05)", bar: "#D1D5DB" },
  cancelled: { border: "#6B7280", bg: "rgba(107,114,128,0.05)", bar: "#6B7280" },
};

const PRIORITY_ICONS: Record<string, { Icon: typeof AlertTriangle; color: string }> = {
  critical: { Icon: AlertTriangle, color: "#EF4444" },
  high: { Icon: ArrowUp, color: "#F97316" },
  medium: { Icon: Minus, color: "#EAB308" },
  low: { Icon: ArrowDown, color: "#3B82F6" },
};

const DEFAULT_STATUS_COLOR = { border: "#6B7280", bg: "rgba(107,114,128,0.05)", bar: "#6B7280" };

// ── Dagre layout ────────────────────────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 40,
    ranksep: 120,
    marginx: 60,
    marginy: 60,
  });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = g.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - NODE_HEIGHT / 2,
      },
      sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
      targetPosition: direction === "LR" ? Position.Left : Position.Top,
    };
  });

  return { nodes: layoutedNodes, edges };
}

// ── Custom Node Component ───────────────────────────────────────────────────

type IssueNodeData = DependencyGraphNode & {
  dimmed?: boolean;
  highlighted?: boolean;
  searchMatch?: boolean;
};

function IssueNode({ data, selected }: NodeProps<Node<IssueNodeData>>) {
  const colors = STATUS_COLORS[data.status] ?? DEFAULT_STATUS_COLOR;
  const priorityDef = data.priority ? PRIORITY_ICONS[data.priority] : null;
  const initials = data.assigneeAgent
    ? data.assigneeAgent.name
        .split(".")
        .map((s: string) => s[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : null;

  return (
    <>
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-muted-foreground !border-none" />
      <div
        className={cn(
          "flex rounded-lg border bg-card text-card-foreground overflow-hidden transition-all",
          selected && "ring-2 shadow-sm",
          data.dimmed && "opacity-30 pointer-events-none",
          data.searchMatch && "ring-2 ring-yellow-400",
        )}
        style={{
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          borderColor: selected ? colors.border : "var(--border)",
          backgroundColor: colors.bg,
          ringColor: selected ? colors.border : undefined,
        }}
      >
        {/* Status bar */}
        <div className="w-1 shrink-0" style={{ backgroundColor: colors.bar }} />

        <div className="flex-1 min-w-0 px-2.5 py-2 flex flex-col justify-between">
          {/* Top row: identifier + priority */}
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] font-mono text-muted-foreground truncate">
              {data.identifier ?? data.id.slice(0, 8)}
            </span>
            {priorityDef && (
              <priorityDef.Icon className="h-3 w-3 shrink-0" style={{ color: priorityDef.color }} />
            )}
          </div>

          {/* Title */}
          <p className="text-xs font-medium leading-tight line-clamp-2">
            {data.title}
          </p>

          {/* Bottom row: assignee */}
          <div className="flex items-center justify-end">
            {initials && (
              <div
                className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[8px] font-bold text-muted-foreground"
                title={data.assigneeAgent?.name}
              >
                {initials}
              </div>
            )}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-muted-foreground !border-none" />
    </>
  );
}

const nodeTypes: NodeTypes = {
  issue: IssueNode,
};

// ── Filter Bar ──────────────────────────────────────────────────────────────

const ALL_STATUSES = ["todo", "in_progress", "in_review", "blocked", "backlog", "done", "cancelled"];
const ACTIVE_STATUSES = ["todo", "in_progress", "in_review", "blocked"];

// ── Main Graph Page ─────────────────────────────────────────────────────────

export function Graph() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    setBreadcrumbs([{ label: "Graph" }]);
  }, [setBreadcrumbs]);

  // Filter state
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [showResolved, setShowResolved] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    searchParams.get("focus") ?? null,
  );

  // Fetch graph data
  const statusParam = statusFilter === "active"
    ? ACTIVE_STATUSES.join(",")
    : statusFilter === "all"
      ? undefined
      : statusFilter;

  const { data: graphData, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.dependencyGraph(selectedCompanyId!, {
      status: statusParam,
      assigneeAgentId: assigneeFilter !== "all" ? assigneeFilter : undefined,
      priority: priorityFilter !== "all" ? priorityFilter : undefined,
    }),
    queryFn: () =>
      issuesApi.dependencyGraph(selectedCompanyId!, {
        status: statusParam,
        assigneeAgentId: assigneeFilter !== "all" ? assigneeFilter : undefined,
        priority: priorityFilter !== "all" ? priorityFilter : undefined,
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // Fetch agents for filter dropdown
  const { data: agentsList } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Build React Flow nodes + edges
  const { flowNodes, flowEdges, nodeMap, edgesByNode } = useMemo(() => {
    if (!graphData) return { flowNodes: [], flowEdges: [], nodeMap: new Map(), edgesByNode: new Map() };

    const nodeMap = new Map<string, DependencyGraphNode>();
    graphData.nodes.forEach((n) => nodeMap.set(n.id, n));

    // Build edge adjacency for detail panel
    const edgesByNode = new Map<string, { blockedBy: DependencyGraphNode[]; blocks: DependencyGraphNode[] }>();
    for (const n of graphData.nodes) {
      edgesByNode.set(n.id, { blockedBy: [], blocks: [] });
    }
    for (const e of graphData.edges) {
      const entry = edgesByNode.get(e.to);
      const fromNode = nodeMap.get(e.from);
      if (entry && fromNode) entry.blockedBy.push(fromNode);
      const sourceEntry = edgesByNode.get(e.from);
      const toNode = nodeMap.get(e.to);
      if (sourceEntry && toNode) sourceEntry.blocks.push(toNode);
    }

    // Filter edges: hide resolved unless showResolved is on
    const visibleEdges = showResolved
      ? graphData.edges
      : graphData.edges.filter((e) => !e.resolved);

    // Build flow edges
    const flowEdges: Edge[] = visibleEdges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "default",
      animated: !e.resolved,
      style: {
        stroke: e.resolved ? "#CBD5E1" : "#94A3B8",
        strokeWidth: e.resolved ? 1 : 2,
        strokeDasharray: e.resolved ? "5 5" : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: e.resolved ? "#CBD5E1" : "#94A3B8",
      },
    }));

    // Search highlighting
    const searchLower = search.toLowerCase().trim();

    // Build flow nodes
    const rawNodes: Node[] = graphData.nodes.map((n) => {
      const matchesSearch =
        !searchLower ||
        (n.identifier?.toLowerCase().includes(searchLower) ?? false) ||
        n.title.toLowerCase().includes(searchLower);

      return {
        id: n.id,
        type: "issue",
        data: {
          ...n,
          dimmed: searchLower ? !matchesSearch : false,
          searchMatch: searchLower ? matchesSearch : false,
        },
        position: { x: 0, y: 0 },
      };
    });

    // Apply dagre layout
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      rawNodes,
      flowEdges,
    );

    return {
      flowNodes: layoutedNodes,
      flowEdges: layoutedEdges,
      nodeMap,
      edgesByNode,
    };
  }, [graphData, showResolved, search]);

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  // Sync when data changes
  useEffect(() => {
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [flowNodes, flowEdges, setNodes, setEdges]);

  const selectedNode = selectedNodeId ? (nodeMap.get(selectedNodeId) ?? null) : null;
  const selectedEdges = selectedNodeId ? (edgesByNode.get(selectedNodeId) ?? null) : null;

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const handleDetailNodeClick = useCallback((id: string) => {
    setSelectedNodeId(id);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSelectedNodeId(null);
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.getElementById("graph-search")?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a company to view the dependency graph.
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-sm text-destructive">Couldn't load the dependency graph.</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full gap-4 p-6">
        <div className="flex gap-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-3 w-full max-w-lg">
            <Skeleton className="h-16 w-full" />
            <div className="flex gap-6 justify-center">
              <Skeleton className="h-16 w-48" />
              <Skeleton className="h-16 w-48" />
            </div>
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const hasNodes = graphData && graphData.nodes.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Filter toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background shrink-0 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            id="graph-search"
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-44 pl-8 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
            {ALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>

        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            {agentsList?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1.5 ml-2">
          <Checkbox
            id="show-resolved"
            checked={showResolved}
            onCheckedChange={(checked) => setShowResolved(checked === true)}
          />
          <label htmlFor="show-resolved" className="text-xs text-muted-foreground cursor-pointer">
            Show resolved
          </label>
        </div>

        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          {graphData && (
            <span>
              {graphData.nodes.length} nodes &middot; {graphData.edges.length} edges
            </span>
          )}
        </div>
      </div>

      {/* Graph canvas */}
      {hasNodes ? (
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.1 }}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            className="bg-background"
            nodesDraggable={false}
          >
            <Background gap={24} size={1} color="var(--border)" />
            <Controls
              showInteractive={false}
              className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent"
            />
            <MiniMap
              nodeColor={(node) => {
                const status = (node.data as IssueNodeData)?.status;
                return (STATUS_COLORS[status] ?? DEFAULT_STATUS_COLOR).bar;
              }}
              maskColor="rgba(0,0,0,0.3)"
              className="!bg-card !border-border !shadow-sm"
              pannable
              zoomable
            />
          </ReactFlow>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <div className="text-4xl">&#x1f310;</div>
          <p className="text-sm font-medium">No dependency relationships yet</p>
          <p className="text-xs max-w-sm text-center">
            Use <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">blockedBy</code> on
            issues to build the graph.
          </p>
        </div>
      )}

      {/* Detail panel */}
      {selectedNode && (
        <DetailPanelWithEdges
          node={selectedNode}
          edges={selectedEdges}
          onClose={() => setSelectedNodeId(null)}
          onNodeClick={handleDetailNodeClick}
        />
      )}
    </div>
  );
}

// ── Detail panel with edge data ─────────────────────────────────────────────

function DetailPanelWithEdges({
  node,
  edges,
  onClose,
  onNodeClick,
}: {
  node: DependencyGraphNode;
  edges: { blockedBy: DependencyGraphNode[]; blocks: DependencyGraphNode[] } | null;
  onClose: () => void;
  onNodeClick: (id: string) => void;
}) {
  const navigate = useNavigate();
  const colors = STATUS_COLORS[node.status] ?? DEFAULT_STATUS_COLOR;
  const priorityDef = node.priority ? PRIORITY_ICONS[node.priority] : null;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[420px] sm:max-w-[420px] overflow-y-auto"
      >
        <SheetHeader className="pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">
              {node.identifier}
            </span>
            {priorityDef && (
              <priorityDef.Icon
                className="h-3.5 w-3.5"
                style={{ color: priorityDef.color }}
              />
            )}
          </div>
          <SheetTitle className="text-sm font-semibold leading-snug">
            {node.title}
          </SheetTitle>
          <div className="flex items-center gap-2 pt-1">
            <StatusBadge status={node.status} />
            {node.assigneeAgent && (
              <span className="text-xs text-muted-foreground">
                {node.assigneeAgent.name}
              </span>
            )}
          </div>
        </SheetHeader>

        <div className="space-y-4 py-4">
          {/* Blocked by section */}
          {edges && edges.blockedBy.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Blocked by
              </h4>
              <div className="space-y-1">
                {edges.blockedBy.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onNodeClick(n.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 text-left transition-colors"
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: (STATUS_COLORS[n.status] ?? DEFAULT_STATUS_COLOR).bar }}
                    />
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {n.identifier}
                    </span>
                    <span className="text-xs truncate">{n.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Blocks section */}
          {edges && edges.blocks.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Blocks
              </h4>
              <div className="space-y-1">
                {edges.blocks.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onNodeClick(n.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 text-left transition-colors"
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: (STATUS_COLORS[n.status] ?? DEFAULT_STATUS_COLOR).bar }}
                    />
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {n.identifier}
                    </span>
                    <span className="text-xs truncate">{n.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {edges &&
            edges.blockedBy.length === 0 &&
            edges.blocks.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No blocker relationships for this issue.
              </p>
            )}
        </div>

        <div className="pt-4 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              navigate(`/issues/${node.identifier ?? node.id}`)
            }
          >
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            View Full Issue
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

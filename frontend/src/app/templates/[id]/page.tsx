"use client";

import "reactflow/dist/style.css";

import clsx from "clsx";
import Link from "next/link";
import ReactFlow, {
  Background,
  BaseEdge,
  Connection,
  Controls,
  Edge,
  EdgeLabelRenderer,
  EdgeProps,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  NodeProps,
  Panel,
  Position,
  getBezierPath,
} from "reactflow";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import {
  ModelProfile,
  ModelProfilesResponse,
  NodeOutputFormat,
  OpenRouterModel,
  OpenRouterModelsResponse,
  Template,
  TemplateConfig,
  TemplateNodeConfig,
  TemplateNodeType,
  ViewerKind,
  apiFetch,
} from "@/lib/api";
import { getStoredToken } from "@/lib/auth";

const ALL_VIEWERS: ViewerKind[] = ["markdown", "pdf", "json", "raw"];
const DEFAULT_INSPECTOR_POS = { x: 32, y: 144 };

type EditorNodeConfig = TemplateNodeConfig & {
  ui?: {
    x: number;
    y: number;
  };
};

type EditorConfig = Omit<TemplateConfig, "nodes"> & {
  nodes: EditorNodeConfig[];
};

type InspectorTarget =
  | { type: "template" }
  | { type: "node"; nodeId: string }
  | { type: "edge"; sourceId: string; targetId: string; ref: string }
  | null;

type FlowNodeData = {
  node: EditorNodeConfig;
  index: number;
  readCount: number;
  selected: boolean;
  related: boolean;
  readOnly: boolean;
  onOpenNode: (nodeId: string) => void;
};

type FlowEdgeData = {
  color: string;
  label: string;
  format: NodeOutputFormat;
  onOpenEdge: () => void;
  onCycleFormat: (direction: 1 | -1) => void;
};

type ConnectionRecord = {
  id: string;
  sourceId: string;
  targetId: string;
  ref: string;
  format: NodeOutputFormat;
};

const OUTPUT_TONES: Record<NodeOutputFormat, { edge: string; badge: string; panel: string }> = {
  markdown: {
    edge: "#0f766e",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
    panel: "border-emerald-200 bg-emerald-50",
  },
  json: {
    edge: "#2563eb",
    badge: "border-blue-200 bg-blue-50 text-blue-800",
    panel: "border-blue-200 bg-blue-50",
  },
  pdf: {
    edge: "#be123c",
    badge: "border-rose-200 bg-rose-50 text-rose-800",
    panel: "border-rose-200 bg-rose-50",
  },
};

function slugifyId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "node";
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function extensionFor(format: NodeOutputFormat): string {
  if (format === "json") return ".json";
  if (format === "pdf") return ".pdf";
  return ".md";
}

function replaceExtension(path: string, format: NodeOutputFormat): string {
  const ext = extensionFor(format);
  if (!path) return `working/output${ext}`;
  if (/\.[a-z0-9]+$/i.test(path)) {
    return path.replace(/\.[a-z0-9]+$/i, ext);
  }
  return `${path}${ext}`;
}

function readRefFor(node: EditorNodeConfig): string {
  return `${node.output.state_section}.${node.output.state_key}`;
}

function allowedFormatsFor(node: EditorNodeConfig): NodeOutputFormat[] {
  if (node.type === "pdf_generator") return ["pdf"];
  return ["markdown", "json"];
}

function cycleFormat(current: NodeOutputFormat, allowed: NodeOutputFormat[], direction: 1 | -1): NodeOutputFormat {
  const index = allowed.indexOf(current);
  const safeIndex = index >= 0 ? index : 0;
  const nextIndex = (safeIndex + direction + allowed.length) % allowed.length;
  return allowed[nextIndex];
}

function defaultPosition(index: number): { x: number; y: number } {
  return { x: 96 + index * 280, y: 120 + (index % 2) * 180 };
}

function normalizeNodes(nodes: TemplateNodeConfig[] = []): EditorNodeConfig[] {
  return nodes.map((node, index) => {
    const current = node as EditorNodeConfig;
    return {
      ...current,
      ui: current.ui ?? defaultPosition(index),
    };
  });
}

function defaultNode(type: TemplateNodeType, existingIds: Set<string>, index: number): EditorNodeConfig {
  if (type === "pdf_generator") {
    const id = uniqueId("pdf_generator", existingIds);
    return {
      id,
      name: "PDF Generator",
      type: "pdf_generator",
      system_prompt: "",
      instruction: "Convert the final markdown document into a PDF.",
      include_message: false,
      include_uploaded_files: false,
      user_prompt_template: "",
      reads: [],
      output: {
        format: "pdf",
        path: "final/output.pdf",
        state_section: "final",
        state_key: "pdf",
      },
      ui: defaultPosition(index),
    };
  }

  const id = uniqueId("new_node", existingIds);
  return {
    id,
    name: "New AI Node",
    type,
    model: "openai/gpt-4o-mini",
    system_prompt: "",
    instruction: "Describe what this node should do.",
    include_message: true,
    include_uploaded_files: false,
    user_prompt_template: "",
    reads: [],
    output: {
      format: "markdown",
      path: `working/${id}.md`,
      state_section: "working",
      state_key: id,
    },
    ui: defaultPosition(index),
  };
}

const EMPTY_CONFIG: EditorConfig = {
  name: "Untitled Template",
  description: "",
  default_viewer: "markdown",
  allowed_viewers: ["markdown", "pdf", "json"],
  nodes: [],
};

export default function TemplateBuilderPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const templateId = params?.id ?? "";
  const isNew = templateId === "new";

  const [template, setTemplate] = useState<Template | null>(null);
  const [config, setConfig] = useState<EditorConfig>(EMPTY_CONFIG);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget>({ type: "template" });
  const [inspectorPos, setInspectorPos] = useState(DEFAULT_INSPECTOR_POS);

  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const userPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const previousInspectorTargetRef = useRef<InspectorTarget>(null);

  const isSeeded = template?.is_seeded === true;
  const readOnly = isSeeded;

  const existingNodeIds = useMemo(() => new Set(config.nodes.map((node) => node.id)), [config.nodes]);

  const selectedNode = useMemo(
    () => config.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [config.nodes, selectedNodeId]
  );

  const upstreamReadOptions = useMemo(() => {
    const map = new Map<string, string[]>();
    config.nodes.forEach((node, index) => {
      map.set(
        node.id,
        config.nodes.slice(0, index).map((candidate) => readRefFor(candidate))
      );
    });
    return map;
  }, [config.nodes]);

  const outputRefToNodeId = useMemo(() => {
    const map = new Map<string, string>();
    config.nodes.forEach((node) => {
      map.set(readRefFor(node), node.id);
    });
    return map;
  }, [config.nodes]);

  const connectionRecords = useMemo<ConnectionRecord[]>(() => {
    const records: ConnectionRecord[] = [];
    config.nodes.forEach((target) => {
      target.reads.forEach((ref) => {
        const sourceId = outputRefToNodeId.get(ref);
        if (!sourceId) return;
        const source = config.nodes.find((node) => node.id === sourceId);
        if (!source) return;
        records.push({
          id: `${sourceId}->${target.id}->${ref}`,
          sourceId,
          targetId: target.id,
          ref,
          format: source.output.format,
        });
      });
    });
    return records;
  }, [config.nodes, outputRefToNodeId]);
  const selectedEdge = useMemo(() => {
    if (!inspectorTarget || inspectorTarget.type !== "edge") return null;
    return (
      connectionRecords.find(
        (record) =>
          record.sourceId === inspectorTarget.sourceId &&
          record.targetId === inspectorTarget.targetId &&
          record.ref === inspectorTarget.ref
      ) ?? null
    );
  }, [connectionRecords, inspectorTarget]);

  const highlightedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!inspectorTarget) return ids;
    if (inspectorTarget.type === "node") ids.add(inspectorTarget.nodeId);
    if (inspectorTarget.type === "edge") {
      ids.add(inspectorTarget.sourceId);
      ids.add(inspectorTarget.targetId);
    }
    return ids;
  }, [inspectorTarget]);

  const openNodeInspector = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setInspectorTarget({ type: "node", nodeId });
  }, []);

  const openEdgeInspector = useCallback((sourceId: string, targetId: string, ref: string) => {
    setInspectorTarget({ type: "edge", sourceId, targetId, ref });
  }, []);

  const loadOpenRouterModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await apiFetch<OpenRouterModelsResponse>("/openrouter-models");
      setOpenRouterModels(res.data ?? []);
      if ((res.data ?? []).length === 0) {
        setModelsError("OpenRouter returned an empty catalog.");
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Failed to load OpenRouter catalog.");
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const updateConfig = useCallback((next: Partial<EditorConfig>) => {
    setConfig((current) => ({ ...current, ...next }));
    setDirty(true);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: (node: EditorNodeConfig) => EditorNodeConfig) => {
    setConfig((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? patch(node) : node)),
    }));
    setDirty(true);
  }, []);

  const updateNodeOutput = useCallback(
    (nodeId: string, patch: Partial<EditorNodeConfig["output"]>) => {
      setConfig((current) => {
        const targetNode = current.nodes.find((node) => node.id === nodeId);
        if (!targetNode) return current;
        const oldRef = readRefFor(targetNode);
        const nextOutput = { ...targetNode.output, ...patch };
        if (patch.format && patch.path === undefined) {
          nextOutput.path = replaceExtension(nextOutput.path, patch.format);
        }
        const nextNode = { ...targetNode, output: nextOutput };
        const newRef = readRefFor(nextNode);
        return {
          ...current,
          nodes: current.nodes.map((node) => {
            if (node.id === nodeId) return nextNode;
            if (oldRef === newRef || !node.reads.includes(oldRef)) return node;
            return {
              ...node,
              reads: node.reads.map((ref) => (ref === oldRef ? newRef : ref)),
            };
          }),
        };
      });
      setDirty(true);
    },
    []
  );

  const moveNode = useCallback((nodeId: string, direction: -1 | 1) => {
    setConfig((current) => {
      const index = current.nodes.findIndex((node) => node.id === nodeId);
      if (index < 0) return current;
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= current.nodes.length) return current;
      const nextNodes = [...current.nodes];
      const [removed] = nextNodes.splice(index, 1);
      nextNodes.splice(targetIndex, 0, removed);
      return { ...current, nodes: nextNodes };
    });
    setDirty(true);
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setConfig((current) => {
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node) return current;
      const removedRef = readRefFor(node);
      return {
        ...current,
        nodes: current.nodes
          .filter((item) => item.id !== nodeId)
          .map((item) => ({
            ...item,
            reads: item.reads.filter((ref) => ref !== removedRef),
          })),
      };
    });
    setSelectedNodeId((current) => (current === nodeId ? "" : current));
    setInspectorTarget((current) => {
      if (!current) return current;
      if (current.type === "node" && current.nodeId === nodeId) return null;
      if (current.type === "edge" && (current.sourceId === nodeId || current.targetId === nodeId)) return null;
      return current;
    });
    setDirty(true);
  }, []);

  const addNode = useCallback((type: TemplateNodeType) => {
    setConfig((current) => {
      const nextNode = defaultNode(type, new Set(current.nodes.map((node) => node.id)), current.nodes.length);
      return { ...current, nodes: [...current.nodes, nextNode] };
    });
    setDirty(true);
  }, []);

  const cycleSourceFormat = useCallback((sourceId: string, direction: 1 | -1) => {
    setConfig((current) => {
      const sourceNode = current.nodes.find((node) => node.id === sourceId);
      if (!sourceNode) return current;
      const allowed = allowedFormatsFor(sourceNode);
      if (allowed.length <= 1) return current;
      const nextFormat = cycleFormat(sourceNode.output.format, allowed, direction);
      const nextOutput = {
        ...sourceNode.output,
        format: nextFormat,
        path: replaceExtension(sourceNode.output.path, nextFormat),
      };
      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === sourceId ? { ...node, output: nextOutput } : node
        ),
      };
    });
    setDirty(true);
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      setConfig((current) => {
        const sourceIndex = current.nodes.findIndex((node) => node.id === connection.source);
        const targetIndex = current.nodes.findIndex((node) => node.id === connection.target);
        if (sourceIndex < 0 || targetIndex < 0) return current;

        const sourceNode = current.nodes[sourceIndex];
        const ref = readRefFor(sourceNode);
        let nextNodes = [...current.nodes];
        let nextTargetIndex = targetIndex;

        if (sourceIndex >= targetIndex) {
          const [targetNode] = nextNodes.splice(targetIndex, 1);
          const nextSourceIndex = nextNodes.findIndex((node) => node.id === connection.source);
          nextTargetIndex = nextSourceIndex + 1;
          nextNodes.splice(nextTargetIndex, 0, targetNode);
        }

        const targetNode = nextNodes[nextTargetIndex];
        if (targetNode.reads.includes(ref)) return { ...current, nodes: nextNodes };
        nextNodes[nextTargetIndex] = {
          ...targetNode,
          reads: [...targetNode.reads, ref],
        };
        return { ...current, nodes: nextNodes };
      });
      setSelectedNodeId(connection.target);
      setInspectorTarget({ type: "node", nodeId: connection.target });
      setDirty(true);
    },
    []
  );

  const removeConnection = useCallback((sourceId: string, targetId: string, ref: string) => {
    setConfig((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === targetId ? { ...node, reads: node.reads.filter((item) => item !== ref) } : node
      ),
    }));
    setInspectorTarget({ type: "node", nodeId: targetId });
    setSelectedNodeId(targetId);
    setDirty(true);
  }, []);

  const handleNodeDragStop = useCallback((_event: unknown, draggedNode: Node) => {
    setConfig((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === draggedNode.id
          ? { ...node, ui: { x: draggedNode.position.x, y: draggedNode.position.y } }
          : node
      ),
    }));
    setDirty(true);
  }, []);

  const flowNodes = useMemo<Node<FlowNodeData>[]>(
    () =>
      config.nodes.map((node, index) => ({
        id: node.id,
        type: "templateNode",
        position: node.ui ?? defaultPosition(index),
        draggable: !readOnly,
        data: {
          node,
          index,
          readCount: node.reads.length,
          selected: inspectorTarget?.type === "node" && node.id === selectedNodeId,
          related: highlightedNodeIds.has(node.id),
          readOnly,
          onOpenNode: openNodeInspector,
        },
      })),
    [config.nodes, highlightedNodeIds, inspectorTarget?.type, openNodeInspector, readOnly, selectedNodeId]
  );

  const flowEdges = useMemo<Edge<FlowEdgeData>[]>(
    () =>
      connectionRecords.map((record) => ({
        id: record.id,
        source: record.sourceId,
        target: record.targetId,
        type: "connectionEdge",
        markerEnd: { type: MarkerType.ArrowClosed, color: OUTPUT_TONES[record.format].edge },
        data: {
          color: OUTPUT_TONES[record.format].edge,
          label: record.ref,
          format: record.format,
          onOpenEdge: () => openEdgeInspector(record.sourceId, record.targetId, record.ref),
          onCycleFormat: (direction: 1 | -1) => cycleSourceFormat(record.sourceId, direction),
        },
      })),
    [connectionRecords, cycleSourceFormat, openEdgeInspector]
  );

  useEffect(() => {
    if (!getStoredToken()) {
      router.replace("/login");
      return;
    }
    apiFetch<ModelProfilesResponse>("/model-profiles")
      .then((res) => setModelProfiles(res.profiles))
      .catch(() => undefined);
    void loadOpenRouterModels();

    if (isNew) {
      setConfig({ ...EMPTY_CONFIG, nodes: [] });
      setLoading(false);
      return;
    }

    setLoading(true);
    apiFetch<Template>(`/templates/${templateId}`)
      .then((tpl) => {
        setTemplate(tpl);
        const cfg = tpl.config_json ?? EMPTY_CONFIG;
        const normalizedNodes = normalizeNodes(cfg.nodes ?? []);
        setConfig({
          name: cfg.name ?? tpl.name,
          description: cfg.description ?? tpl.description,
          default_viewer: cfg.default_viewer ?? "markdown",
          allowed_viewers: cfg.allowed_viewers ?? ["markdown", "pdf", "json"],
          nodes: normalizedNodes,
        });
        if (normalizedNodes[0]) {
          setSelectedNodeId(normalizedNodes[0].id);
          setInspectorTarget({ type: "node", nodeId: normalizedNodes[0].id });
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Template not found.");
      })
      .finally(() => setLoading(false));
  }, [isNew, loadOpenRouterModels, router, templateId]);

  useEffect(() => {
    if (config.nodes.length === 0) {
      setSelectedNodeId("");
      return;
    }
    if (!config.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(config.nodes[0].id);
    }
  }, [config.nodes, selectedNodeId]);

  useEffect(() => {
    if (inspectorTarget && !previousInspectorTargetRef.current) {
      setInspectorPos(DEFAULT_INSPECTOR_POS);
    }
    previousInspectorTargetRef.current = inspectorTarget;
  }, [inspectorTarget]);

  useEffect(() => {
    if (!inspectorTarget) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (inspectorRef.current?.contains(target)) return;
      setInspectorTarget(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [inspectorTarget]);

  const startInspectorDrag = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const offsetX = event.clientX - inspectorPos.x;
    const offsetY = event.clientY - inspectorPos.y;

    const onMove = (moveEvent: MouseEvent) => {
      setInspectorPos({
        x: Math.max(16, moveEvent.clientX - offsetX),
        y: Math.max(88, moveEvent.clientY - offsetY),
      });
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [inspectorPos.x, inspectorPos.y]);

  async function handleSave() {
    setError(null);
    setInfo(null);
    if (!config.name.trim()) {
      setError("Template name is required.");
      return;
    }
    if (config.nodes.length === 0) {
      setError("Add at least one node before saving.");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await apiFetch<Template>("/templates", {
          method: "POST",
          body: JSON.stringify({
            name: config.name,
            description: config.description ?? "",
            config_json: config,
          }),
        });
        setDirty(false);
        router.replace(`/templates/${created.id}`);
      } else {
        const updated = await apiFetch<Template>(`/templates/${templateId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: config.name,
            description: config.description ?? "",
            config_json: config,
          }),
        });
        setTemplate(updated);
        setDirty(false);
        setInfo("Saved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading template...
      </main>
    );
  }
  return (
    <main className="flex h-screen flex-col bg-slate-100 text-slate-900">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-xs">
            <Link className="font-medium text-slate-500 hover:underline" href="/workspace">
              Back to workspace
            </Link>
            <span className="text-slate-300">/</span>
            <Link className="font-medium text-slate-500 hover:underline" href="/templates">
              Templates
            </Link>
            <span className="text-slate-300">/</span>
            <span className="font-medium text-slate-700">Builder</span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              className={clsx(
                "min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold text-slate-950 outline-none",
                !readOnly && "hover:border-slate-200 focus:border-slate-300"
              )}
              value={config.name}
              readOnly={readOnly}
              onChange={(event) => updateConfig({ name: event.target.value })}
            />
            {isSeeded ? (
              <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                Seeded read-only
              </span>
            ) : null}
            {dirty ? (
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                Unsaved
              </span>
            ) : null}
          </div>
          <input
            className={clsx(
              "mt-1 block w-full max-w-3xl rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm text-slate-500 outline-none",
              !readOnly && "hover:border-slate-200 focus:border-slate-300"
            )}
            placeholder="Template description"
            value={config.description ?? ""}
            readOnly={readOnly}
            onChange={(event) => updateConfig({ description: event.target.value })}
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => setInspectorTarget({ type: "template" })}
          >
            Template settings
          </button>
          <Link
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            href="/workspace"
          >
            Open workspace
          </Link>
          {readOnly && template ? (
            <button
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
              onClick={async () => {
                try {
                  const cloned = await apiFetch<Template>(`/templates/${template.id}/clone`, {
                    method: "POST",
                  });
                  router.push(`/templates/${cloned.id}`);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Clone failed.");
                }
              }}
            >
              Clone to edit
            </button>
          ) : null}
          <button
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
            disabled={readOnly || saving || !dirty}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">{error}</div>
      ) : null}
      {info ? (
        <div className="border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-xs text-emerald-700">{info}</div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-white">
          <div className="border-b border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.08),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.08),_transparent_32%),#f8fafc] px-4 py-4">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="flex flex-wrap gap-3">
                <button
                  className="group w-[220px] rounded-3xl border border-slate-200 bg-white px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md disabled:opacity-50"
                  disabled={readOnly}
                  onClick={() => addNode("ai")}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quick add</div>
                  <div className="mt-2 text-base font-semibold text-slate-950">AI node</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">Prompt-driven step for extraction, outlining, drafting, or review.</div>
                </button>
                <button
                  className="group w-[220px] rounded-3xl border border-slate-200 bg-white px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md disabled:opacity-50"
                  disabled={readOnly}
                  onClick={() => addNode("pdf_generator")}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quick add</div>
                  <div className="mt-2 text-base font-semibold text-slate-950">PDF node</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">Converts the final markdown output into a generated PDF artifact.</div>
                </button>
                <button
                  className="w-[220px] rounded-3xl border border-slate-200 bg-white px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                  onClick={() => setInspectorTarget({ type: "template" })}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Global</div>
                  <div className="mt-2 text-base font-semibold text-slate-950">Template settings</div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">Viewer defaults, description, and any top-level output choices.</div>
                </button>
              </div>

              <div className="grid gap-2 rounded-3xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-600 shadow-sm xl:w-[360px]">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Fast loop</div>
                <div>1. Drag cards to place the pipeline visually.</div>
                <div>2. Pull from the right pin into the next node to add a read.</div>
                <div>3. Hover a node or edge to open the floating inspector.</div>
                <div>4. Scroll on a connection to cycle the output type feeding the next step.</div>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {config.nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6">
                <div className="grid max-w-4xl gap-4 text-center lg:grid-cols-[1.2fr_1fr]">
                  <div className="rounded-[32px] border border-slate-200 bg-white px-8 py-8 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Start here</div>
                    <h2 className="mt-3 text-2xl font-semibold text-slate-950">Build the pipeline visually.</h2>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                      Add your first node, then drag cards around the canvas and connect the pins to build the flow.
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-3">
                      <button
                        className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
                        disabled={readOnly}
                        onClick={() => addNode("ai")}
                      >
                        Add AI node
                      </button>
                      <button
                        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-50"
                        disabled={readOnly}
                        onClick={() => addNode("pdf_generator")}
                      >
                        Add PDF node
                      </button>
                    </div>
                  </div>

                  <div className="rounded-[32px] border border-slate-200 bg-slate-50 px-6 py-8 text-left shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Fast loop</div>
                    <div className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                      <div>1. Add a node.</div>
                      <div>2. Drag it where you want it.</div>
                      <div>3. Pull from the right pin into the next node.</div>
                      <div>4. Use the floating inspector to edit the Todo, inputs, and output.</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={{ templateNode: FlowTemplateNode }}
                edgeTypes={{ connectionEdge: FlowConnectionEdge }}
                fitView
                fitViewOptions={{ padding: 0.16 }}
                minZoom={0.3}
                maxZoom={1.5}
                snapToGrid
                snapGrid={[16, 16]}
                onNodeDragStop={handleNodeDragStop}
                onNodeClick={(_, node) => openNodeInspector(node.id)}
                onConnect={handleConnect}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "connectionEdge" }}
              >
                <Background color="#dbe4ef" gap={24} />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeStrokeWidth={3}
                  nodeColor={(node) => {
                    const templateNode = config.nodes.find((item) => item.id === node.id);
                    return templateNode ? OUTPUT_TONES[templateNode.output.format].edge : "#94a3b8";
                  }}
                  nodeStrokeColor={(node) => {
                    const templateNode = config.nodes.find((item) => item.id === node.id);
                    if (!templateNode) return "#cbd5e1";
                    return highlightedNodeIds.has(templateNode.id) ? "#0f172a" : OUTPUT_TONES[templateNode.output.format].edge;
                  }}
                  maskColor="rgba(241, 245, 249, 0.72)"
                  style={{ background: "rgba(255,255,255,0.96)", border: "1px solid #e2e8f0" }}
                />
                <Panel position="bottom-left">
                  <div className="w-[280px] rounded-3xl border border-slate-200 bg-white/96 px-4 py-4 text-sm text-slate-600 shadow-[0_14px_36px_rgba(15,23,42,0.12)] backdrop-blur">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Connection behavior</div>
                    <div className="mt-3 space-y-2">
                      <div>Connected outputs immediately show up in the target node's Todo section.</div>
                      <div>Edge color always matches the source output type.</div>
                      <div>Use the floating inspector as the fast edit surface. It stays open until you click outside or close it.</div>
                    </div>
                  </div>
                </Panel>
              </ReactFlow>
            )}
          </div>
        </div>

        {inspectorTarget ? (
          <div
            ref={inspectorRef}
            className="absolute z-30 w-[460px] rounded-3xl border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)]"
            style={{ left: inspectorPos.x, top: inspectorPos.y }}
          >
            <div
              className="flex cursor-move items-center justify-between rounded-t-3xl border-b border-slate-200 bg-slate-950 px-4 py-3 text-white"
              onMouseDown={startInspectorDrag}
            >
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">Inspector</p>
                <p className="mt-1 text-sm font-semibold text-white">
                  {inspectorTarget.type === "template"
                    ? "Template settings"
                    : inspectorTarget.type === "node"
                      ? selectedNode?.name ?? "Node"
                      : "Connection"}
                </p>
              </div>
              <button
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setInspectorTarget(null)}
              >
                Close
              </button>
            </div>

            <div className="max-h-[78vh] overflow-y-auto p-4">
              {inspectorTarget.type === "template" ? (
                <TemplateSettingsPanel
                  config={config}
                  readOnly={readOnly}
                  onChange={updateConfig}
                />
              ) : inspectorTarget.type === "node" && selectedNode ? (
                <NodeInspector
                  node={selectedNode}
                  stepIndex={config.nodes.findIndex((node) => node.id === selectedNode.id)}
                  upstreamReadOptions={upstreamReadOptions.get(selectedNode.id) ?? []}
                  modelProfiles={modelProfiles}
                  openRouterModels={openRouterModels}
                  modelsLoading={modelsLoading}
                  modelsError={modelsError}
                  readOnly={readOnly}
                  allNodes={config.nodes}
                  userPromptRef={userPromptRef}
                  onRetryModels={() => void loadOpenRouterModels()}
                  onChange={(patch) => updateNode(selectedNode.id, (node) => ({ ...node, ...patch }))}
                  onChangeName={(value) =>
                    updateNode(selectedNode.id, (node) => ({
                      ...node,
                      name: value,
                      id: node.id || slugifyId(value),
                    }))
                  }
                  onChangeOutput={(patch) => updateNodeOutput(selectedNode.id, patch)}
                  onMoveUp={() => moveNode(selectedNode.id, -1)}
                  onMoveDown={() => moveNode(selectedNode.id, 1)}
                  onDelete={() => deleteNode(selectedNode.id)}
                  onToggleRead={(ref) =>
                    updateNode(selectedNode.id, (node) => ({
                      ...node,
                      reads: node.reads.includes(ref)
                        ? node.reads.filter((item) => item !== ref)
                        : [...node.reads, ref],
                    }))
                  }
                />
              ) : inspectorTarget.type === "edge" && selectedEdge ? (
                <EdgeInspector
                  record={selectedEdge}
                  sourceNode={config.nodes.find((node) => node.id === selectedEdge.sourceId) ?? null}
                  targetNode={config.nodes.find((node) => node.id === selectedEdge.targetId) ?? null}
                  onCycle={(direction) => cycleSourceFormat(selectedEdge.sourceId, direction)}
                  onDisconnect={() => removeConnection(selectedEdge.sourceId, selectedEdge.targetId, selectedEdge.ref)}
                  onOpenTarget={() => openNodeInspector(selectedEdge.targetId)}
                />
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  Hover a node or connection to inspect it.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
function FlowTemplateNode({ data }: NodeProps<FlowNodeData>) {
  const tone = OUTPUT_TONES[data.node.output.format];
  const previewRefs = data.node.reads.slice(0, 2);
  return (
    <div
      className={clsx(
        "relative w-[320px] cursor-pointer rounded-[28px] border bg-white px-5 py-5 shadow-[0_18px_50px_rgba(15,23,42,0.12)] transition",
        data.selected
          ? "border-slate-950 ring-2 ring-slate-900/10 shadow-[0_24px_70px_rgba(15,23,42,0.18)]"
          : data.related
            ? "border-slate-400 shadow-[0_22px_55px_rgba(15,23,42,0.16)]"
            : "border-slate-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_22px_60px_rgba(15,23,42,0.16)]"
      )}
      onMouseEnter={() => data.onOpenNode(data.node.id)}
      onClick={() => data.onOpenNode(data.node.id)}
    >
      <div className="absolute inset-x-5 top-0 h-1.5 rounded-b-full" style={{ backgroundColor: tone.edge }} />
      <Handle
        id={`${data.node.id}-in`}
        type="target"
        position={Position.Left}
        isConnectable={!data.readOnly}
        style={{ width: 18, height: 18, left: -10, background: tone.edge, border: "3px solid white", boxShadow: "0 0 0 3px rgba(255,255,255,0.55)" }}
      />
      <Handle
        id={`${data.node.id}-out`}
        type="source"
        position={Position.Right}
        isConnectable={!data.readOnly}
        style={{ width: 18, height: 18, right: -10, background: tone.edge, border: "3px solid white", boxShadow: "0 0 0 3px rgba(255,255,255,0.55)" }}
      />

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Step {data.index + 1}
          </p>
          <h3 className="mt-1 text-base font-semibold text-slate-950">{data.node.name}</h3>
        </div>
        <span className={clsx("rounded-full border px-2 py-1 text-[11px] font-semibold", tone.badge)}>
          {data.node.output.format}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-700">{data.node.type}</span>
        <span>{data.readCount} input ref{data.readCount === 1 ? "" : "s"}</span>
        <span className="rounded-full bg-slate-50 px-2 py-1 text-slate-500">{data.node.output.path}</span>
      </div>

      <div className="mt-4 rounded-3xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Todo</div>
          {previewRefs.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              {previewRefs.map((ref) => (
                <span key={ref} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-semibold text-blue-800">
                  {ref}
                </span>
              ))}
              {data.node.reads.length > previewRefs.length ? (
                <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-500">
                  +{data.node.reads.length - previewRefs.length}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-4 text-sm leading-6 text-slate-600">
          {data.node.instruction || "No todo text yet. Open the inspector and describe the work for this node."}
        </p>
      </div>

      <div className={clsx("mt-4 rounded-3xl border px-3 py-3 text-[11px] text-slate-700", tone.panel)}>
        <div className="font-semibold uppercase tracking-[0.14em] text-slate-500">Output reference</div>
        <div className="mt-1 font-mono text-[11px] text-slate-900">{readRefFor(data.node)}</div>
      </div>
    </div>
  );
}

function FlowConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<FlowEdgeData>) {
  const tone = data ? OUTPUT_TONES[data.format] : OUTPUT_TONES.markdown;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: data?.color, strokeWidth: 4 }} />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        onMouseEnter={() => data?.onOpenEdge()}
        onClick={() => data?.onOpenEdge()}
        onWheel={(event) => {
          event.preventDefault();
          data?.onOpenEdge();
          data?.onCycleFormat(event.deltaY > 0 ? 1 : -1);
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={clsx("pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-white/96 px-3 py-2 text-[11px] font-semibold text-slate-700 shadow-[0_10px_28px_rgba(15,23,42,0.14)]", tone.badge)}
          style={{ left: labelX, top: labelY }}
          onMouseEnter={() => data?.onOpenEdge()}
          onClick={() => data?.onOpenEdge()}
          onWheel={(event) => {
            event.preventDefault();
            data?.onOpenEdge();
            data?.onCycleFormat(event.deltaY > 0 ? 1 : -1);
          }}
        >
          <div className="flex items-center gap-2">
            <span>{data?.format}</span>
            <span className="text-slate-400">feeds</span>
            <span className="font-mono text-[10px]">{data?.label}</span>
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function TemplateSettingsPanel({
  config,
  readOnly,
  onChange,
}: {
  config: EditorConfig;
  readOnly: boolean;
  onChange: (next: Partial<EditorConfig>) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Description" hint="Short summary shown in the workspace when this template is attached to a project.">
        <textarea
          className="min-h-[96px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900"
          value={config.description ?? ""}
          readOnly={readOnly}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </Field>

      <Field label="Default viewer" hint="Which output view opens first in the workspace.">
        <select
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
          value={config.default_viewer ?? "markdown"}
          disabled={readOnly}
          onChange={(event) => onChange({ default_viewer: event.target.value as ViewerKind })}
        >
          {ALL_VIEWERS.map((viewer) => (
            <option key={viewer} value={viewer}>
              {viewer}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Allowed viewers" hint="Which tabs are available in the workspace output viewer.">
        <div className="grid gap-2 sm:grid-cols-2">
          {ALL_VIEWERS.map((viewer) => {
            const checked = config.allowed_viewers?.includes(viewer) ?? false;
            return (
              <label key={viewer} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readOnly}
                  onChange={(event) => {
                    const current = new Set(config.allowed_viewers ?? []);
                    if (event.target.checked) current.add(viewer);
                    else current.delete(viewer);
                    onChange({ allowed_viewers: Array.from(current) as ViewerKind[] });
                  }}
                />
                {viewer}
              </label>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

function NodeInspector({
  node,
  stepIndex,
  upstreamReadOptions,
  modelProfiles,
  openRouterModels,
  modelsLoading,
  modelsError,
  readOnly,
  allNodes,
  userPromptRef,
  onRetryModels,
  onChange,
  onChangeName,
  onChangeOutput,
  onMoveUp,
  onMoveDown,
  onDelete,
  onToggleRead,
}: {
  node: EditorNodeConfig;
  stepIndex: number;
  upstreamReadOptions: string[];
  modelProfiles: ModelProfile[];
  openRouterModels: OpenRouterModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  readOnly: boolean;
  allNodes: EditorNodeConfig[];
  userPromptRef: React.RefObject<HTMLTextAreaElement | null>;
  onRetryModels: () => void;
  onChange: (patch: Partial<EditorNodeConfig>) => void;
  onChangeName: (value: string) => void;
  onChangeOutput: (patch: Partial<EditorNodeConfig["output"]>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onToggleRead: (ref: string) => void;
}) {
  const matchedModel = openRouterModels.find((model) => model.id === (node.model ?? "")) ?? null;
  const todoRefs = node.reads.map((ref) => ({
    ref,
    source: allNodes.find((candidate) => readRefFor(candidate) === ref) ?? null,
  }));

  const insertIntoUserPrompt = (variable: string) => {
    const textarea = userPromptRef.current;
    const current = node.user_prompt_template ?? "";
    if (!textarea) {
      onChange({ user_prompt_template: `${current}${variable}` });
      return;
    }
    const start = textarea.selectionStart ?? current.length;
    const end = textarea.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${variable}${current.slice(end)}`;
    onChange({ user_prompt_template: next });
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + variable.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Execution step</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-950">{stepIndex + 1}. {node.name}</h3>
            <p className="mt-1 text-sm text-slate-500">{node.type} node</p>
          </div>
          <span className={clsx("rounded-full border px-2 py-1 text-[11px] font-semibold", OUTPUT_TONES[node.output.format].badge)}>
            {node.output.format}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={readOnly || stepIndex === 0} onClick={onMoveUp}>Move earlier</button>
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={readOnly || stepIndex === allNodes.length - 1} onClick={onMoveDown}>Move later</button>
          <button className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50" disabled={readOnly} onClick={onDelete}>Delete node</button>
        </div>
      </div>

      <Field label="Node name" hint="Human-readable label for the canvas and run logs.">
        <input className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" value={node.name} readOnly={readOnly} onChange={(event) => onChangeName(event.target.value)} />
      </Field>

      <Field label="Todo for this node" hint="Describe the work this node should do. Connected references show up here immediately so the task stays visually grounded.">
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Incoming references</div>
              <div className="text-[11px] text-slate-400">Visual connections land here immediately.</div>
            </div>
            {todoRefs.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No upstream references yet. Connect a pin to feed this node.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {todoRefs.map(({ ref, source }) => (
                  <button
                    key={ref}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-3 py-2 text-left hover:bg-blue-100 disabled:cursor-default"
                    disabled={readOnly}
                    onClick={() => onToggleRead(ref)}
                  >
                    <div>
                      <div className="text-xs font-semibold text-blue-900">{source?.name ?? "Upstream node"}</div>
                      <div className="mt-1 font-mono text-[11px] text-blue-800">{ref}</div>
                    </div>
                    {!readOnly ? <div className="text-[11px] font-semibold text-blue-700">Remove</div> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
          <textarea className="min-h-[140px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900" value={node.instruction ?? ""} readOnly={readOnly} onChange={(event) => onChange({ instruction: event.target.value })} />
        </div>
      </Field>

      <Field label="Model" hint="Direct model id is fastest. The profile is a higher-level fallback choice.">
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <input className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" list="openrouter-models" placeholder="openai/gpt-4o-mini" value={node.model ?? ""} readOnly={readOnly || node.type === "pdf_generator"} onChange={(event) => onChange({ model: event.target.value, model_profile: null })} />
          <datalist id="openrouter-models">
            {openRouterModels.map((model) => (
              <option key={model.id} value={model.id}>{model.name || model.id}</option>
            ))}
          </datalist>
          <select className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" value={node.model_profile ?? ""} disabled={readOnly || node.type === "pdf_generator"} onChange={(event) => onChange({ model_profile: event.target.value || null })}>
            <option value="">No model profile</option>
            {modelProfiles.map((profile) => (
              <option key={profile.slug} value={profile.slug}>{profile.slug}</option>
            ))}
          </select>
          {matchedModel ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <div className="font-semibold text-slate-800">{matchedModel.name || matchedModel.id}</div>
              {matchedModel.description ? <div className="mt-1">{matchedModel.description}</div> : null}
              {formatPricing(matchedModel) ? <div className="mt-1">{formatPricing(matchedModel)}</div> : null}
            </div>
          ) : null}
          {modelsError ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span>{modelsError}</span>
              <button className="rounded border border-amber-300 bg-white px-2 py-1 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50" disabled={modelsLoading} onClick={onRetryModels}>{modelsLoading ? "Retrying..." : "Retry"}</button>
            </div>
          ) : null}
        </div>
      </Field>

      <Field label="Runtime context" hint="Fast toggles for what the node receives during execution.">
        <div className="space-y-2">
          <ToggleRow checked={node.include_message ?? true} disabled={readOnly} onChange={(value) => onChange({ include_message: value })} label="User message" description="Pass the chat request into this node." />
          <ToggleRow checked={node.include_uploaded_files ?? false} disabled={readOnly} onChange={(value) => onChange({ include_uploaded_files: value })} label="Uploaded files" description="Pass the project file list into this node." />
        </div>
      </Field>

      <Field label="Connected inputs" hint="You can connect pins visually or toggle inputs here.">
        <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-3">
          {upstreamReadOptions.length === 0 ? (
            <span className="text-sm text-slate-400">No upstream nodes yet.</span>
          ) : (
            upstreamReadOptions.map((ref) => (
              <button key={ref} className={clsx("rounded-full border px-3 py-1 text-xs font-semibold", node.reads.includes(ref) ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")} disabled={readOnly} onClick={() => onToggleRead(ref)}>{ref}</button>
            ))
          )}
        </div>
      </Field>

      <Field label="Advanced prompt template" hint="Optional power-user override. Reads become ${working_key} style variables.">
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <VariablePicker reads={node.reads} disabled={readOnly} onInsert={insertIntoUserPrompt} />
          <textarea ref={userPromptRef} className="min-h-[120px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 font-mono text-xs text-slate-800" value={node.user_prompt_template ?? ""} readOnly={readOnly} onChange={(event) => onChange({ user_prompt_template: event.target.value })} />
          <textarea className="min-h-[90px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800" placeholder="System prompt" value={node.system_prompt ?? ""} readOnly={readOnly} onChange={(event) => onChange({ system_prompt: event.target.value })} />
        </div>
      </Field>

      <Field label="Output" hint="This controls the artifact the node writes and what downstream nodes receive.">
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <select className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" value={node.output.format} disabled={readOnly || node.type === "pdf_generator"} onChange={(event) => onChangeOutput({ format: event.target.value as NodeOutputFormat })}>
            {allowedFormatsFor(node).map((format) => (
              <option key={format} value={format}>{format}</option>
            ))}
          </select>
          <input className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900" value={node.output.path} readOnly={readOnly} onChange={(event) => onChangeOutput({ path: event.target.value })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <input className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" value={node.output.state_section} readOnly={readOnly} onChange={(event) => onChangeOutput({ state_section: event.target.value })} />
            <input className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" value={node.output.state_key} readOnly={readOnly} onChange={(event) => onChangeOutput({ state_key: event.target.value })} />
          </div>
          <div className={clsx("rounded-2xl border px-3 py-3 text-sm", OUTPUT_TONES[node.output.format].panel)}>
            Downstream reference: <span className="font-mono font-semibold">{readRefFor(node)}</span>
          </div>
        </div>
      </Field>
    </div>
  );
}

function EdgeInspector({
  record,
  sourceNode,
  targetNode,
  onCycle,
  onDisconnect,
  onOpenTarget,
}: {
  record: ConnectionRecord;
  sourceNode: EditorNodeConfig | null;
  targetNode: EditorNodeConfig | null;
  onCycle: (direction: 1 | -1) => void;
  onDisconnect: () => void;
  onOpenTarget: () => void;
}) {
  const tone = OUTPUT_TONES[record.format];
  return (
    <div className="space-y-4">
      <div className={clsx("rounded-2xl border p-4", tone.panel)}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Connection</p>
        <h3 className="mt-2 text-lg font-semibold text-slate-950">{sourceNode?.name ?? record.sourceId} -> {targetNode?.name ?? record.targetId}</h3>
        <p className="mt-2 text-sm text-slate-600">This edge feeds <span className="font-semibold">{record.ref}</span> into the target node.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/70 bg-white/80 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Source</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{sourceNode?.name ?? record.sourceId}</div>
            <div className="mt-1 font-mono text-[11px] text-slate-600">{sourceNode ? readRefFor(sourceNode) : record.sourceId}</div>
          </div>
          <div className="rounded-2xl border border-white/70 bg-white/80 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Target todo reference</div>
            <div className="mt-2 font-mono text-[11px] text-slate-900">{record.ref}</div>
            <div className="mt-1 text-sm text-slate-600">{targetNode?.name ?? record.targetId}</div>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Output type</p>
            <p className="mt-1 text-sm text-slate-600">Hover or click the edge, then scroll to cycle the source node output.</p>
          </div>
          <span className={clsx("rounded-full border px-3 py-1.5 text-xs font-semibold", tone.badge)}>{record.format}</span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => onCycle(-1)}>Previous type</button>
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => onCycle(1)}>Next type</button>
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={onOpenTarget}>Open target node</button>
          <button className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={onDisconnect}>Disconnect</button>
        </div>
      </div>
    </div>
  );
}

function VariablePicker({
  reads,
  onInsert,
  disabled,
}: {
  reads: string[];
  onInsert: (variable: string) => void;
  disabled?: boolean;
}) {
  const runtimeVars = [
    { variable: "${message}", label: "User message" },
    { variable: "${message_short}", label: "Short message" },
    { variable: "${uploaded_files}", label: "Uploaded files" },
  ];
  const readVars = reads.map((ref) => ({
    variable: `\${${ref.replace(/\./g, "_")}}`,
    label: ref,
  }));
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Insert variable</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {[...runtimeVars, ...readVars].map((item) => (
          <button key={item.variable} type="button" className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => onInsert(item.variable)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</label>
      <div className="mt-2">{children}</div>
      {hint ? <p className="mt-2 text-xs leading-5 text-slate-500">{hint}</p> : null}
    </div>
  );
}

function ToggleRow({
  checked,
  disabled,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className={clsx("flex items-start gap-3 rounded-2xl border px-3 py-3", checked ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white", disabled && "opacity-60") }>
      <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <div>
        <div className="text-sm font-semibold text-slate-800">{label}</div>
        {description ? <div className="mt-1 text-xs text-slate-500">{description}</div> : null}
      </div>
    </label>
  );
}

function formatPricing(model: OpenRouterModel): string | null {
  const prompt = model.pricing?.prompt;
  const completion = model.pricing?.completion;
  if (!prompt && !completion) return null;
  const fmt = (raw: string | undefined) => {
    if (!raw) return "?";
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return "free";
    const perMillion = num * 1_000_000;
    return `$${perMillion.toFixed(2)}/M`;
  };
  return `${fmt(prompt)} in · ${fmt(completion)} out`;
}

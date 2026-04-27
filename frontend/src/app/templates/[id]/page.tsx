"use client";

import "reactflow/dist/style.css";

import Link from "next/link";
import clsx from "clsx";
import ReactFlow, { Background, Controls, Edge, MarkerType, Node } from "reactflow";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import {
  ModelProfile,
  ModelProfilesResponse,
  NodeOutputFormat,
  Template,
  TemplateConfig,
  TemplateNodeConfig,
  TemplateNodeType,
  ViewerKind,
  apiFetch,
} from "@/lib/api";
import { getStoredToken } from "@/lib/auth";

const PROFILE_LABELS: Record<string, string> = {
  fast_classifier: "Fast Classifier",
  json_extractor: "JSON Extractor",
  premium_writer: "Premium Writer",
  deep_reasoner: "Deep Reasoner",
};

const PROFILE_DESCRIPTIONS: Record<string, string> = {
  fast_classifier: "Cheap, fast model for routing/classification tasks.",
  json_extractor: "Strong at producing structured JSON output.",
  premium_writer: "Top-tier writing model for outlines, drafts, final polish.",
  deep_reasoner: "Reasoning-heavy model for QA, planning, and judgment calls.",
};

const ALL_VIEWERS: ViewerKind[] = ["markdown", "pdf", "json", "raw"];

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

function defaultNode(type: TemplateNodeType, existingIds: Set<string>): TemplateNodeConfig {
  if (type === "plan") {
    const id = uniqueId("plan", existingIds);
    return {
      id,
      name: "Plan",
      type: "plan",
      model_profile: "deep_reasoner",
      system_prompt:
        "You are the planning node. Produce a concise plantodo.md before any execution node acts.",
      user_prompt_template: "User request:\n${message}\n\nUploaded files:\n${uploaded_files}",
      reads: [],
      output: {
        format: "markdown",
        path: "working/plantodo.md",
        state_section: "working",
        state_key: "plan",
      },
    };
  }
  if (type === "pdf_generator") {
    const id = uniqueId("pdf_generator", existingIds);
    return {
      id,
      name: "PDF Generator",
      type: "pdf_generator",
      model_profile: null,
      system_prompt: "",
      user_prompt_template: "",
      reads: [],
      output: {
        format: "pdf",
        path: "final/output.pdf",
        state_section: "final",
        state_key: "pdf",
      },
    };
  }
  // ai
  const baseId = uniqueId("new_node", existingIds);
  return {
    id: baseId,
    name: "New AI Node",
    type: "ai",
    model_profile: "premium_writer",
    system_prompt: "",
    user_prompt_template: "User message:\n${message}",
    reads: [],
    output: {
      format: "markdown",
      path: `working/${baseId}.md`,
      state_section: "working",
      state_key: baseId,
    },
  };
}

const EMPTY_CONFIG: TemplateConfig = {
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
  const [config, setConfig] = useState<TemplateConfig>(EMPTY_CONFIG);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>([]);

  const isSeeded = template?.is_seeded === true;
  const readOnly = isSeeded;

  // Bootstrap: auth + load
  useEffect(() => {
    if (!getStoredToken()) {
      router.replace("/login");
      return;
    }
    apiFetch<ModelProfilesResponse>("/model-profiles")
      .then((res) => setModelProfiles(res.profiles))
      .catch(() => undefined);

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
        setConfig({
          name: cfg.name ?? tpl.name,
          description: cfg.description ?? tpl.description,
          default_viewer: cfg.default_viewer ?? "markdown",
          allowed_viewers: cfg.allowed_viewers ?? ["markdown", "pdf", "json"],
          nodes: cfg.nodes ?? [],
        });
        setSelectedNodeId(cfg.nodes?.[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Template not found.");
      })
      .finally(() => setLoading(false));
  }, [isNew, router, templateId]);

  const existingNodeIds = useMemo(() => new Set(config.nodes.map((n) => n.id)), [config.nodes]);

  const upstreamReadOptions = useMemo(() => {
    if (!selectedNodeId) return [] as string[];
    const idx = config.nodes.findIndex((n) => n.id === selectedNodeId);
    if (idx <= 0) return [];
    return config.nodes
      .slice(0, idx)
      .map((n) => `${n.output.state_section}.${n.output.state_key}`);
  }, [config.nodes, selectedNodeId]);

  const selectedNode = useMemo(
    () => config.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [config.nodes, selectedNodeId]
  );

  const flowNodes: Node[] = useMemo(
    () =>
      config.nodes.map((node, index) => ({
        id: node.id,
        position: { x: index * 280, y: index % 2 === 0 ? 40 : 200 },
        draggable: false,
        data: {
          label: (
            <div className="w-[220px]">
              <p className="truncate text-sm font-semibold text-slate-950">{node.name}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">{node.type}</p>
              <p className="mt-1 break-words text-[10px] text-slate-600">
                {node.model_profile ?? "no model"}
              </p>
              <p className="mt-1 break-words font-mono text-[10px] text-slate-500">
                → {node.output.path}
              </p>
            </div>
          ),
        },
        style: {
          width: 248,
          padding: 12,
          borderRadius: 16,
          border: node.id === selectedNodeId ? "2px solid #0f172a" : "1px solid #cbd5e1",
          background: "#ffffff",
          boxShadow:
            node.id === selectedNodeId
              ? "0 18px 40px rgba(15, 23, 42, 0.16)"
              : "0 10px 24px rgba(15, 23, 42, 0.08)",
        },
      })),
    [config.nodes, selectedNodeId]
  );

  const flowEdges: Edge[] = useMemo(() => {
    if (config.nodes.length < 2) return [];
    return config.nodes.slice(0, -1).map((node, index) => ({
      id: `${node.id}-${config.nodes[index + 1].id}`,
      source: node.id,
      target: config.nodes[index + 1].id,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
      style: { stroke: "#94a3b8", strokeWidth: 2 },
    }));
  }, [config.nodes]);

  const updateConfig = useCallback((next: Partial<TemplateConfig>) => {
    setConfig((current) => ({ ...current, ...next }));
    setDirty(true);
  }, []);

  const updateNode = useCallback(
    (nodeId: string, patch: (node: TemplateNodeConfig) => TemplateNodeConfig) => {
      setConfig((current) => ({
        ...current,
        nodes: current.nodes.map((n) => (n.id === nodeId ? patch(n) : n)),
      }));
      setDirty(true);
    },
    []
  );

  const addNode = useCallback(
    (type: TemplateNodeType) => {
      setConfig((current) => {
        const ids = new Set(current.nodes.map((n) => n.id));
        const fresh = defaultNode(type, ids);
        return { ...current, nodes: [...current.nodes, fresh] };
      });
      setDirty(true);
    },
    []
  );

  const moveNode = useCallback((nodeId: string, direction: -1 | 1) => {
    setConfig((current) => {
      const idx = current.nodes.findIndex((n) => n.id === nodeId);
      if (idx < 0) return current;
      const target = idx + direction;
      if (target < 0 || target >= current.nodes.length) return current;
      const next = [...current.nodes];
      const [removed] = next.splice(idx, 1);
      next.splice(target, 0, removed);
      return { ...current, nodes: next };
    });
    setDirty(true);
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setConfig((current) => ({
      ...current,
      nodes: current.nodes.filter((n) => n.id !== nodeId),
    }));
    setSelectedNodeId((current) => (current === nodeId ? "" : current));
    setDirty(true);
  }, []);

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
        Loading template…
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
        <div className="min-w-0">
          <Link className="text-xs font-medium text-slate-500 hover:underline" href="/templates">
            ← Templates
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <input
              className={clsx(
                "min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-semibold text-slate-950 outline-none",
                !readOnly && "hover:border-slate-200 focus:border-slate-300"
              )}
              value={config.name}
              readOnly={readOnly}
              onChange={(event) => updateConfig({ name: event.target.value })}
            />
            {isSeeded ? (
              <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                Seeded · read-only
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
              "mt-1 block w-full max-w-2xl rounded-lg border border-transparent bg-transparent px-2 py-0.5 text-xs text-slate-500 outline-none",
              !readOnly && "hover:border-slate-200 focus:border-slate-300"
            )}
            placeholder="Description"
            value={config.description ?? ""}
            readOnly={readOnly}
            onChange={(event) => updateConfig({ description: event.target.value })}
          />
        </div>
        <div className="flex items-center gap-2">
          {info ? <span className="text-xs text-emerald-700">{info}</span> : null}
          {readOnly && template ? (
            <button
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
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
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">{error}</div>
      ) : null}

      <div className="grid h-full min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px]">
        {/* CANVAS */}
        <div className="flex h-full min-h-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Add node</span>
            <button
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              disabled={readOnly}
              onClick={() => addNode("ai")}
            >
              + AI
            </button>
            <button
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              disabled={readOnly}
              onClick={() => addNode("plan")}
            >
              + Plan
            </button>
            <button
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              disabled={readOnly}
              onClick={() => addNode("pdf_generator")}
            >
              + PDF Generator
            </button>
            <span className="ml-auto text-[10px] text-slate-400">
              Edges are drawn from node order. Reads declare data dependencies.
            </span>
          </div>
          <div className="flex-1">
            {config.nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                Empty template. Click <span className="mx-1 font-semibold">+ AI</span> to add your first node.
              </div>
            ) : (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#cbd5e1" gap={24} />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
        </div>

        {/* PROPERTIES */}
        <aside className="flex h-full min-h-0 flex-col bg-slate-50">
          {selectedNode ? (
            <NodePropertiesPanel
              node={selectedNode}
              upstreamReadOptions={upstreamReadOptions}
              modelProfiles={modelProfiles}
              readOnly={readOnly}
              isFirst={config.nodes[0]?.id === selectedNode.id}
              isLast={config.nodes[config.nodes.length - 1]?.id === selectedNode.id}
              onChange={(patch) => updateNode(selectedNode.id, (n) => ({ ...n, ...patch }))}
              onChangeOutput={(patch) =>
                updateNode(selectedNode.id, (n) => ({ ...n, output: { ...n.output, ...patch } }))
              }
              onMoveUp={() => moveNode(selectedNode.id, -1)}
              onMoveDown={() => moveNode(selectedNode.id, 1)}
              onDelete={() => deleteNode(selectedNode.id)}
            />
          ) : (
            <TemplatePropertiesPanel
              config={config}
              readOnly={readOnly}
              onChange={(patch) => updateConfig(patch)}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

function TemplatePropertiesPanel({
  config,
  readOnly,
  onChange,
}: {
  config: TemplateConfig;
  readOnly: boolean;
  onChange: (patch: Partial<TemplateConfig>) => void;
}) {
  const allowedViewers = config.allowed_viewers ?? [];
  const toggleViewer = (viewer: ViewerKind) => {
    if (readOnly) return;
    const set = new Set(allowedViewers);
    if (set.has(viewer)) set.delete(viewer);
    else set.add(viewer);
    onChange({ allowed_viewers: Array.from(set) as ViewerKind[] });
  };
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Template settings</h3>
        <p className="mt-1 text-xs text-slate-500">Click a node on the canvas to edit it.</p>
      </div>
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Default viewer
        </label>
        <select
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          value={config.default_viewer ?? "markdown"}
          disabled={readOnly}
          onChange={(event) => onChange({ default_viewer: event.target.value as ViewerKind })}
        >
          {ALL_VIEWERS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Allowed viewers
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          {ALL_VIEWERS.map((viewer) => (
            <button
              key={viewer}
              className={clsx(
                "rounded-lg px-2.5 py-1 text-xs font-semibold",
                allowedViewers.includes(viewer)
                  ? "bg-slate-900 text-white"
                  : "border border-slate-200 bg-white text-slate-600"
              )}
              disabled={readOnly}
              onClick={() => toggleViewer(viewer)}
            >
              {viewer}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NodePropertiesPanel({
  node,
  upstreamReadOptions,
  modelProfiles,
  readOnly,
  isFirst,
  isLast,
  onChange,
  onChangeOutput,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  node: TemplateNodeConfig;
  upstreamReadOptions: string[];
  modelProfiles: ModelProfile[];
  readOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<TemplateNodeConfig>) => void;
  onChangeOutput: (patch: Partial<TemplateNodeConfig["output"]>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const isAi = node.type === "ai" || node.type === "plan";
  const isPdf = node.type === "pdf_generator";
  const toggleRead = (ref: string) => {
    if (readOnly) return;
    const next = new Set(node.reads);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    onChange({ reads: Array.from(next) });
  };

  const profileFallback: ModelProfile[] = modelProfiles.length
    ? modelProfiles
    : [
        { slug: "fast_classifier", primary: null, fallback: null },
        { slug: "json_extractor", primary: null, fallback: null },
        { slug: "premium_writer", primary: null, fallback: null },
        { slug: "deep_reasoner", primary: null, fallback: null },
      ];
  const activeProfile = profileFallback.find((p) => p.slug === node.model_profile);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Node</p>
            <h3 className="mt-0.5 text-base font-semibold text-slate-900">{node.name}</h3>
            <p className="mt-0.5 font-mono text-[10px] text-slate-500">
              {node.id} · {node.type}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <button
              className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-30"
              disabled={readOnly || isFirst}
              onClick={onMoveUp}
            >
              ↑
            </button>
            <button
              className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-30"
              disabled={readOnly || isLast}
              onClick={onMoveDown}
            >
              ↓
            </button>
            <button
              className="rounded-md border border-red-200 px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-30"
              disabled={readOnly}
              onClick={onDelete}
            >
              Del
            </button>
          </div>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-600">
          {isAi
            ? "This node calls an AI model with the prompts below, then writes its result to a file other nodes can read."
            : isPdf
              ? "This node converts a markdown file produced by an upstream node into a PDF. No AI call."
              : "Custom node."}
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-5 py-4">
        <Field label="Name" hint="What you'll see this node called in the canvas and chat history.">
          <input
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={node.name}
            readOnly={readOnly}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>

        {isAi ? (
          <>
            <Field
              label="OpenRouter model"
              hint={
                activeProfile?.primary
                  ? `Currently uses ${activeProfile.primary}${activeProfile.fallback ? ` (falls back to ${activeProfile.fallback})` : ""}. Pick the profile best suited to this node's task.`
                  : "Pick the model profile best suited for this node's task."
              }
            >
              <select
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                value={node.model_profile ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({ model_profile: event.target.value })}
              >
                {profileFallback.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {PROFILE_LABELS[p.slug] ?? p.slug}
                    {p.primary ? ` — ${p.primary}` : ""}
                  </option>
                ))}
              </select>
              {activeProfile && PROFILE_DESCRIPTIONS[activeProfile.slug] ? (
                <p className="mt-1 text-[10px] italic text-slate-400">
                  {PROFILE_DESCRIPTIONS[activeProfile.slug]}
                </p>
              ) : null}
            </Field>

            <Field
              label="System prompt"
              hint="Persistent instructions sent to the model on every call (e.g., 'You are a careful proposal writer. Only output markdown.')."
            >
              <textarea
                className="min-h-[80px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                value={node.system_prompt}
                readOnly={readOnly}
                onChange={(event) => onChange({ system_prompt: event.target.value })}
              />
            </Field>

            <Field
              label="User prompt template"
              hint="The actual message sent to the model. Inject runtime data with placeholders: ${message} = the user's chat input, ${uploaded_files} = JSON list of project uploads, ${working_intent} (or any ${section_key}) = output from a node you declared in Reads."
            >
              <textarea
                className="min-h-[120px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
                value={node.user_prompt_template}
                readOnly={readOnly}
                onChange={(event) => onChange({ user_prompt_template: event.target.value })}
              />
            </Field>
          </>
        ) : null}

        <Field
          label="Reads"
          hint={
            upstreamReadOptions.length === 0
              ? "No upstream nodes yet — add nodes above this one. Reads are how a node consumes the output of an earlier node."
              : "Tick which upstream nodes' outputs this node should read. Each ticked entry becomes a ${section_key} variable you can use in the prompt template."
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {upstreamReadOptions.length === 0 ? (
              <span className="text-xs text-slate-400">(none available)</span>
            ) : (
              upstreamReadOptions.map((ref) => (
                <button
                  key={ref}
                  className={clsx(
                    "rounded-md px-2 py-1 font-mono text-[10px]",
                    node.reads.includes(ref)
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600"
                  )}
                  disabled={readOnly}
                  onClick={() => toggleRead(ref)}
                >
                  {ref}
                </button>
              ))
            )}
          </div>
        </Field>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Output</p>
          <p className="mt-1 text-[10px] text-slate-500">
            What this node writes when it runs. Each run, the output is saved to the project's
            cloud storage at the path below, and downstream nodes can read it.
          </p>
          <div className="mt-2 grid gap-3">
            <Field
              label="Format"
              hint="json = structured data the model returns as JSON. markdown = readable text/document. pdf = converts an upstream markdown file into a PDF."
            >
              <select
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                value={node.output.format}
                disabled={readOnly}
                onChange={(event) =>
                  onChangeOutput({ format: event.target.value as NodeOutputFormat })
                }
              >
                <option value="json">json — structured data</option>
                <option value="markdown">markdown — readable document</option>
                <option value="pdf">pdf — printable document</option>
              </select>
            </Field>
            <Field
              label="File path"
              hint="The relative path inside this project's cloud folder. Must start with one of: input/, working/ (intermediate results), final/ (finished outputs), logs/, archive/."
            >
              <input
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
                value={node.output.path}
                readOnly={readOnly}
                onChange={(event) => onChangeOutput({ path: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="State section"
                hint="Bucket name in the run's state object. Convention: 'working' for intermediate, 'final' for end products."
              >
                <input
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={node.output.state_section}
                  readOnly={readOnly}
                  onChange={(event) => onChangeOutput({ state_section: event.target.value })}
                />
              </Field>
              <Field
                label="State key"
                hint="Name downstream nodes use to read this output. Combined: section.key (e.g. working.intent)."
              >
                <input
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={node.output.state_key}
                  readOnly={readOnly}
                  onChange={(event) => onChangeOutput({ state_key: event.target.value })}
                />
              </Field>
            </div>
            <p className="rounded-md bg-slate-50 px-2 py-1.5 font-mono text-[10px] text-slate-600">
              Downstream nodes can read this as:{" "}
              <span className="font-semibold">
                {node.output.state_section}.{node.output.state_key}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-[10px] text-slate-400">{hint}</p> : null}
    </div>
  );
}

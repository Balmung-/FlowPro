"use client";

import "react18-json-view/src/style.css";
import "reactflow/dist/style.css";

import clsx from "clsx";
import JsonView from "react18-json-view";
import ReactMarkdown from "react-markdown";
import ReactFlow, { Background, Controls, Edge, MarkerType, Node } from "reactflow";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { API_BASE, Artifact, ChatMessage, NodeExecution, Project, Run, RunDetail, RunEvent, apiFetch } from "@/lib/api";
import { clearAuthSession, getStoredToken } from "@/lib/auth";

const WORKFLOW_STEPS = [
  { id: "intent_parser", name: "Intent Parser" },
  { id: "requirement_extractor", name: "Requirement Extractor" },
  { id: "outline_builder", name: "Outline Builder" },
  { id: "draft_writer", name: "Draft Writer" },
  { id: "critic_qa", name: "Critic QA" },
  { id: "final_writer", name: "Final Writer" },
  { id: "pdf_generator", name: "PDF Generator" }
] as const;

const STREAM_EVENT_TYPES = ["run.started", "node.started", "node.completed", "node.failed", "artifact.created", "run.completed", "run.failed"];
const TAB_KEYS = ["flow", "data", "files", "output", "logs"] as const;

type TabKey = (typeof TAB_KEYS)[number];

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function statusTone(status: string): string {
  switch (status) {
    case "running":
      return "bg-amber-100 text-amber-900 border border-amber-200";
    case "completed":
      return "bg-emerald-100 text-emerald-900 border border-emerald-200";
    case "failed":
      return "bg-red-100 text-red-900 border border-red-200";
    case "skipped":
      return "bg-slate-200 text-slate-700 border border-slate-300";
    default:
      return "bg-slate-100 text-slate-700 border border-slate-200";
  }
}

function filePreviewPath(artifactId: string): string {
  return `${API_BASE}/artifacts/${artifactId}/content`;
}

export default function WorkspacePage() {
  const router = useRouter();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("flow");
  const [selectedNodeId, setSelectedNodeId] = useState<string>(WORKFLOW_STEPS[0].id);
  const [messageInput, setMessageInput] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [previewArtifactId, setPreviewArtifactId] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewIsPdf, setPreviewIsPdf] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [outputMode, setOutputMode] = useState<"markdown" | "pdf">("markdown");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const selectedRunSummary = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? selectedRun ?? null, [runs, selectedRun, selectedRunId]);

  const filesByGroup = useMemo(() => {
    const grouped = { input: [] as Artifact[], working: [] as Artifact[], final: [] as Artifact[], logs: [] as Artifact[], archive: [] as Artifact[] };
    for (const artifact of files) {
      const group = artifact.path.split("/")[0] as keyof typeof grouped;
      if (group in grouped) {
        grouped[group].push(artifact);
      }
    }
    return grouped;
  }, [files]);

  const activeRunArtifacts = useMemo(() => (selectedRun?.artifacts ?? []).filter((artifact) => artifact.deleted_at === null), [selectedRun]);
  const latestMarkdownArtifact = useMemo(() => activeRunArtifacts.find((artifact) => artifact.path === "final/output.md") ?? null, [activeRunArtifacts]);
  const latestPdfArtifact = useMemo(() => activeRunArtifacts.find((artifact) => artifact.path === "final/output.pdf") ?? null, [activeRunArtifacts]);

  const nodeExecutions = useMemo(() => new Map((selectedRun?.node_executions ?? []).map((node) => [node.node_id, node])), [selectedRun]);
  const selectedNode = nodeExecutions.get(selectedNodeId) ?? null;

  const flowNodes: Node[] = useMemo(() => {
    return WORKFLOW_STEPS.map((step, index) => {
      const execution = nodeExecutions.get(step.id);
      const status = execution?.status ?? "waiting";
      return {
        id: step.id,
        position: { x: index * 340, y: index % 2 === 0 ? 40 : 220 },
        draggable: false,
        data: {
          label: (
            <div className="w-[280px]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-slate-950">{step.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{execution?.node_type ?? "workflow node"}</p>
                </div>
                <span className={clsx("rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]", statusTone(status))}>{status}</span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-600">
                <div><dt className="uppercase tracking-wide text-slate-400">Model</dt><dd className="mt-1 break-words text-slate-700">{execution?.model_used ?? execution?.model_profile ?? "n/a"}</dd></div>
                <div><dt className="uppercase tracking-wide text-slate-400">Tokens</dt><dd className="mt-1 text-slate-700">{(execution?.token_input ?? 0) + (execution?.token_output ?? 0)}</dd></div>
                <div><dt className="uppercase tracking-wide text-slate-400">Cost</dt><dd className="mt-1 text-slate-700">{execution?.cost_estimate != null ? `$${execution.cost_estimate.toFixed(4)}` : "n/a"}</dd></div>
                <div><dt className="uppercase tracking-wide text-slate-400">Artifacts</dt><dd className="mt-1 text-slate-700">{execution?.output_json?.artifact_id ? "1" : "0"}</dd></div>
              </dl>
            </div>
          )
        },
        style: { width: 308, padding: 18, borderRadius: 22, border: step.id === selectedNodeId ? "2px solid #0f172a" : "1px solid #cbd5e1", background: "#ffffff", boxShadow: step.id === selectedNodeId ? "0 18px 45px rgba(15, 23, 42, 0.18)" : "0 14px 36px rgba(15, 23, 42, 0.10)" }
      };
    });
  }, [nodeExecutions, selectedNodeId]);

  const flowEdges: Edge[] = useMemo(() => WORKFLOW_STEPS.slice(0, -1).map((step, index) => ({ id: `${step.id}-${WORKFLOW_STEPS[index + 1].id}`, source: step.id, target: WORKFLOW_STEPS[index + 1].id, type: "smoothstep", animated: nodeExecutions.get(step.id)?.status === "running", markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" }, style: { stroke: "#94a3b8", strokeWidth: 2 } })), [nodeExecutions]);

  const loadRunDetail = useCallback(async (runId: string) => {
    if (!runId) {
      setSelectedRun(null);
      return null;
    }
    const detail = await apiFetch<RunDetail>(`/runs/${runId}`);
    setSelectedRun(detail);
    setSelectedNodeId((current) => (detail.node_executions.some((node) => node.node_id === current) ? current : WORKFLOW_STEPS[0].id));
    return detail;
  }, []);

  const loadProjects = useCallback(async () => {
    const projectList = await apiFetch<Project[]>("/projects");
    setProjects(projectList);
    setSelectedProjectId((current) => (current && projectList.some((project) => project.id === current) ? current : projectList[0]?.id ?? ""));
  }, []);

  const loadProjectData = useCallback(async (projectId: string, preferredRunId?: string) => {
    if (!projectId) {
      setMessages([]); setFiles([]); setRuns([]); setSelectedRunId(""); setSelectedRun(null); return;
    }
    setIsLoadingWorkspace(true);
    try {
      const [nextMessages, nextFiles, nextRuns] = await Promise.all([apiFetch<ChatMessage[]>(`/projects/${projectId}/messages`), apiFetch<Artifact[]>(`/projects/${projectId}/files`), apiFetch<Run[]>(`/projects/${projectId}/runs`)]);
      setMessages(nextMessages); setFiles(nextFiles); setRuns(nextRuns);
      const runIdToSelect = preferredRunId && nextRuns.some((run) => run.id === preferredRunId) ? preferredRunId : selectedRunId && nextRuns.some((run) => run.id === selectedRunId) ? selectedRunId : nextRuns[0]?.id ?? "";
      setSelectedRunId(runIdToSelect);
      if (runIdToSelect) { await loadRunDetail(runIdToSelect); } else { setSelectedRun(null); }
    } finally { setIsLoadingWorkspace(false); }
  }, [loadRunDetail, selectedRunId]);

  const loadArtifactPreview = useCallback(async (artifact: Artifact) => {
    setPreviewArtifactId(artifact.id); setPreviewError(null);
    const contentUrl = filePreviewPath(artifact.id);
    setPreviewUrl(contentUrl);
    const isPdf = artifact.mime_type.includes("pdf");
    setPreviewIsPdf(isPdf);
    if (isPdf) { setPreviewText(""); return; }
    if (artifact.mime_type.startsWith("text/") || artifact.mime_type.includes("json") || artifact.mime_type.includes("markdown")) {
      const response = await fetch(contentUrl, { cache: "no-store" });
      if (!response.ok) { throw new Error(`Preview failed for ${artifact.filename}`); }
      setPreviewText(await response.text());
      return;
    }
    setPreviewText("Binary preview is not available for this file type.");
  }, []);

  useEffect(() => {
    if (!getStoredToken()) {
      router.replace("/login");
      return;
    }

    loadProjects().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load projects.");
    });

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      seenEventIdsRef.current.clear();
    };
  }, [loadProjects, router]);

  useEffect(() => {
    if (!selectedProjectId) {
      setMessages([]); setFiles([]); setRuns([]); setSelectedRunId(""); setSelectedRun(null); return;
    }

    loadProjectData(selectedProjectId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load project workspace.");
    });
  }, [loadProjectData, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !selectedRunId) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      seenEventIdsRef.current.clear();
      return;
    }

    const token = getStoredToken();
    if (!token) {
      return;
    }

    eventSourceRef.current?.close();
    seenEventIdsRef.current = new Set();

    const source = new EventSource(`${API_BASE}/runs/${selectedRunId}/events?token=${encodeURIComponent(token)}`);
    eventSourceRef.current = source;

    const handleStreamMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as RunEvent;
        if (seenEventIdsRef.current.has(payload.id)) { return; }
        seenEventIdsRef.current.add(payload.id);
        setSelectedRun((current) => (!current || current.id !== selectedRunId || current.events.some((item) => item.id === payload.id) ? current : { ...current, events: [...current.events, payload] }));
        loadProjectData(selectedProjectId, selectedRunId).catch(() => undefined);
        if (["run.completed", "run.failed", "run.cancelled"].includes(payload.type)) {
          source.close();
          if (eventSourceRef.current === source) { eventSourceRef.current = null; }
        }
      } catch (streamError) {
        setError(streamError instanceof Error ? streamError.message : "Failed to process live run event.");
      }
    };

    for (const eventType of STREAM_EVENT_TYPES) { source.addEventListener(eventType, handleStreamMessage as EventListener); }
    source.onmessage = handleStreamMessage;

    return () => {
      source.close();
      if (eventSourceRef.current === source) { eventSourceRef.current = null; }
    };
  }, [loadProjectData, selectedProjectId, selectedRunId]);

  useEffect(() => {
    const outputArtifact = outputMode === "markdown" ? latestMarkdownArtifact : latestPdfArtifact;
    if (!outputArtifact) {
      if (activeTab === "output") {
        setPreviewArtifactId(""); setPreviewText(""); setPreviewUrl(""); setPreviewIsPdf(false);
      }
      return;
    }
    loadArtifactPreview(outputArtifact).catch((previewLoadError) => {
      setPreviewError(previewLoadError instanceof Error ? previewLoadError.message : "Output preview failed.");
    });
  }, [activeTab, latestMarkdownArtifact, latestPdfArtifact, loadArtifactPreview, outputMode]);

  async function handleCreateProject() {
    if (!projectName.trim()) { return; }
    setIsCreatingProject(true); setError(null);
    try {
      const project = await apiFetch<Project>("/projects", { method: "POST", body: JSON.stringify({ name: projectName.trim(), description: projectDescription.trim() }) });
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setProjectName(""); setProjectDescription(""); setSelectedProjectId(project.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Project creation failed.");
    } finally { setIsCreatingProject(false); }
  }

  async function handleRunWorkflow() {
    if (!selectedProjectId || !messageInput.trim()) { return; }
    setIsStartingRun(true); setError(null);
    try {
      const run = await apiFetch<Run>(`/projects/${selectedProjectId}/runs`, { method: "POST", body: JSON.stringify({ input_message: messageInput.trim() }) });
      setMessageInput(""); setActiveTab("flow"); setSelectedRunId(run.id);
      await loadProjectData(selectedProjectId, run.id);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run creation failed.");
    } finally { setIsStartingRun(false); }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (!selectedProjectId || selectedFiles.length === 0) { return; }

    setIsUploadingFiles(true); setError(null);
    try {
      for (const file of selectedFiles) {
        const relativePath = `input/${file.name}`;
        const { upload_url } = await apiFetch<{ upload_url: string }>(`/projects/${selectedProjectId}/files/upload-url`, { method: "POST", body: JSON.stringify({ relative_path: relativePath, mime_type: file.type || "application/octet-stream" }) });
        const uploadResponse = await fetch(upload_url, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        if (!uploadResponse.ok) { throw new Error(`Upload failed for ${file.name}`); }
        await apiFetch(`/projects/${selectedProjectId}/files/confirm-upload`, { method: "POST", body: JSON.stringify({ relative_path: relativePath, filename: file.name, mime_type: file.type || "application/octet-stream", size_bytes: file.size }) });
      }
      await loadProjectData(selectedProjectId, selectedRunId || undefined);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "File upload failed.");
    } finally {
      event.target.value = "";
      setIsUploadingFiles(false);
    }
  }

  async function handleSelectRun(runId: string) {
    setSelectedRunId(runId); setError(null);
    if (!runId) { setSelectedRun(null); return; }
    try { await loadRunDetail(runId); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Run load failed."); }
  }

  async function handleDownload(artifact: Artifact) {
    const { download_url } = await apiFetch<{ download_url: string }>(`/artifacts/${artifact.id}/download-url`);
    window.open(download_url, "_blank", "noopener,noreferrer");
  }

  async function handleDelete(artifact: Artifact) {
    setError(null);
    try {
      await apiFetch(`/artifacts/${artifact.id}`, { method: "DELETE" });
      if (previewArtifactId === artifact.id) { setPreviewArtifactId(""); setPreviewText(""); setPreviewUrl(""); setPreviewIsPdf(false); }
      if (selectedProjectId) { await loadProjectData(selectedProjectId, selectedRunId || undefined); }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Delete failed.");
    }
  }

  function handleSignOut() {
    clearAuthSession();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    seenEventIdsRef.current.clear();
    router.push("/login");
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.14),_transparent_28%),linear-gradient(180deg,_#f8fafc_0%,_#e2e8f0_100%)] p-4 md:p-6">
      <div className="grid min-h-[calc(100vh-2rem)] grid-cols-1 gap-5 xl:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col rounded-[28px] border border-slate-200 bg-white/95 p-5 shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">FlowPro</p>
              <h1 className="mt-2 text-2xl font-semibold text-slate-950">Document Cockpit</h1>
              <p className="mt-2 text-sm text-slate-500">Project chat, file intake, and workflow execution in one place.</p>
            </div>
            <button className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50" onClick={handleSignOut}>Logout</button>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-800">Project selector</label>
              <select className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
                <option value="">Select a project</option>
                {projects.map((project) => (<option key={project.id} value={project.id}>{project.name}</option>))}
              </select>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Create project</h2>
              <input className="mt-3 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900" placeholder="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
              <textarea className="mt-3 min-h-[88px] w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900" placeholder="Project description" value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} />
              <button className="mt-3 w-full rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" onClick={handleCreateProject} disabled={isCreatingProject}>{isCreatingProject ? "Creating project..." : "Create project"}</button>
            </div>
          </div>

          <section className="mt-5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-slate-50">
            <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Chat history</h2></div>
            <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">No messages yet for this project.</p> : null}
              {messages.map((message) => (
                <article key={message.id} className={clsx("rounded-3xl px-4 py-4 text-sm shadow-sm", {"bg-slate-950 text-white": message.role === "user", "bg-white text-slate-800": message.role === "assistant", "bg-amber-50 text-amber-950": message.role === "system"})}>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] opacity-70">{message.role}</div>
                  <div className="whitespace-pre-wrap leading-6">{message.content}</div>
                </article>
              ))}
            </div>
          </section>

          <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="block text-sm font-semibold text-slate-800">Document request</label>
            <textarea className="mt-3 min-h-[132px] w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-900" placeholder="Type the document request for the fixed Document Generator workflow." value={messageInput} onChange={(event) => setMessageInput(event.target.value)} />
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input className="hidden" multiple ref={uploadRef} type="file" onChange={handleUpload} />
              <button className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50" onClick={() => uploadRef.current?.click()} disabled={!selectedProjectId || isUploadingFiles}>{isUploadingFiles ? "Uploading files..." : "Upload file"}</button>
              <button className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 disabled:opacity-60" onClick={handleRunWorkflow} disabled={!selectedProjectId || !messageInput.trim() || isStartingRun}>{isStartingRun ? "Starting run..." : "Run workflow"}</button>
            </div>
          </div>

          {error ? <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        </aside>

        <section className="flex min-h-0 flex-col rounded-[28px] border border-slate-200 bg-white/95 shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
          <header className="border-b border-slate-200 px-5 py-5">
            <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Workspace</p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">{selectedProject?.name ?? "No project selected"}</h2>
                <p className="mt-2 text-sm text-slate-500">{selectedProject ? (selectedProject.description || "Run the fixed workflow, inspect node state, and manage generated files.") : "Create or select a project to begin."}</p>
              </div>
              <div className="flex flex-col gap-3 xl:items-end">
                <div className="flex flex-wrap items-center gap-3">
                  <select className="min-w-[260px] rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900" value={selectedRunId} onChange={(event) => void handleSelectRun(event.target.value)}>
                    <option value="">No run selected</option>
                    {runs.map((run) => (<option key={run.id} value={run.id}>{run.id} · {run.status}</option>))}
                  </select>
                  <span className={clsx("rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em]", statusTone(selectedRunSummary?.status ?? "waiting"))}>{selectedRunSummary?.status ?? "idle"}</span>
                  <button className="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 disabled:opacity-60" onClick={handleRunWorkflow} disabled={!selectedProjectId || !messageInput.trim() || isStartingRun}>{isStartingRun ? "Starting run..." : "Run"}</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {TAB_KEYS.map((tab) => (<button key={tab} className={clsx("rounded-2xl px-4 py-2.5 text-sm font-semibold", activeTab === tab ? "bg-slate-950 text-white" : "border border-slate-300 bg-white text-slate-700")} onClick={() => setActiveTab(tab)}>{tab === "flow" ? "Node Flow" : tab === "data" ? "Data Inspector" : tab === "output" ? "Output Viewer" : tab === "logs" ? "Logs" : "Files"}</button>))}
                </div>
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 px-5 py-5">
            {activeTab === "flow" ? (
              <div className="grid h-full grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_380px]">
                <div className="h-[calc(100vh-240px)] min-h-[620px] overflow-hidden rounded-[28px] border border-slate-200 bg-slate-50">
                  <ReactFlow nodes={flowNodes} edges={flowEdges} fitView fitViewOptions={{ padding: 0.2 }} onNodeClick={(_, node) => setSelectedNodeId(node.id)} nodesDraggable={false} nodesConnectable={false} elementsSelectable proOptions={{ hideAttribution: true }}>
                    <Background color="#cbd5e1" gap={28} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                </div>

                <aside className="scrollbar-thin h-[calc(100vh-240px)] min-h-[620px] overflow-y-auto rounded-[28px] border border-slate-200 bg-white p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Node details</p>
                      <h3 className="mt-2 text-xl font-semibold text-slate-950">{selectedNode?.node_name ?? WORKFLOW_STEPS.find((step) => step.id === selectedNodeId)?.name}</h3>
                    </div>
                    <span className={clsx("rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]", statusTone(selectedNode?.status ?? "waiting"))}>{selectedNode?.status ?? "waiting"}</span>
                  </div>

                  <div className="mt-5 grid gap-4">
                    <div className="grid grid-cols-2 gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Model used</p><p className="mt-1 break-words">{selectedNode?.model_used ?? selectedNode?.model_profile ?? "n/a"}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Cost estimate</p><p className="mt-1">{selectedNode?.cost_estimate != null ? `$${selectedNode.cost_estimate.toFixed(4)}` : "n/a"}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Token input</p><p className="mt-1">{selectedNode?.token_input ?? 0}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Token output</p><p className="mt-1">{selectedNode?.token_output ?? 0}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Started at</p><p className="mt-1">{formatDateTime(selectedNode?.started_at)}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Completed at</p><p className="mt-1">{formatDateTime(selectedNode?.completed_at)}</p></div>
                    </div>

                    {selectedNode?.error_message ? <div className="rounded-3xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{selectedNode.error_message}</div> : null}

                    <div className="rounded-3xl border border-slate-200 bg-white p-4"><h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">Input JSON</h4><div className="mt-3 overflow-auto text-sm"><JsonView collapsed={1} src={selectedNode?.input_json ?? {}} /></div></div>
                    <div className="rounded-3xl border border-slate-200 bg-white p-4"><h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">Output JSON</h4><div className="mt-3 overflow-auto text-sm"><JsonView collapsed={1} src={selectedNode?.output_json ?? {}} /></div></div>
                  </div>
                </aside>
              </div>
            ) : null}

            {activeTab === "data" ? (selectedRun ? <div className="scrollbar-thin h-[calc(100vh-240px)] min-h-[620px] overflow-auto rounded-[28px] border border-slate-200 bg-white p-5"><JsonView collapsed={2} src={selectedRun.state_json ?? {}} /></div> : <div className="flex h-[calc(100vh-240px)] min-h-[620px] items-center justify-center rounded-[28px] border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">Select a run to inspect its state_json.</div>) : null}

            {activeTab === "files" ? (
              <div className="grid h-full grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
                <div className="scrollbar-thin h-[calc(100vh-240px)] min-h-[620px] overflow-y-auto rounded-[28px] border border-slate-200 bg-white p-5">
                  {(["input", "working", "final", "logs", "archive"] as const).map((group) => (
                    <section key={group} className="mb-8 last:mb-0">
                      <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">{group}</h3><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{filesByGroup[group].length}</span></div>
                      {filesByGroup[group].length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">No files in this group.</div> : (
                        <div className="space-y-3">
                          {filesByGroup[group].map((artifact) => (
                            <div key={`${artifact.id}-${artifact.path}`} className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                                <div>
                                  <p className="text-base font-semibold text-slate-950">{artifact.filename}</p>
                                  <p className="mt-1 break-all text-xs text-slate-500">{artifact.path}</p>
                                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500"><span>{artifact.mime_type}</span><span>{formatBytes(artifact.size_bytes)}</span><span>{formatDateTime(artifact.created_at)}</span></div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <button className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700" onClick={() => loadArtifactPreview(artifact).catch((previewLoadError) => setPreviewError(previewLoadError instanceof Error ? previewLoadError.message : "Preview failed."))}>Preview</button>
                                  <button className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700" onClick={() => void handleDownload(artifact)}>Download</button>
                                  <button className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700" onClick={() => navigator.clipboard.writeText(artifact.path).catch(() => undefined)}>Copy path</button>
                                  <button className="rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-700" onClick={() => void handleDelete(artifact)}>Delete</button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>

                <aside className="scrollbar-thin h-[calc(100vh-240px)] min-h-[620px] overflow-y-auto rounded-[28px] border border-slate-200 bg-white p-5">
                  <h3 className="text-lg font-semibold text-slate-950">Preview</h3>
                  {previewError ? <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{previewError}</p> : null}
                  {!previewArtifactId ? <p className="mt-4 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">Select a file to preview it here.</p> : null}
                  {previewArtifactId && previewUrl ? (previewIsPdf ? <iframe className="mt-4 h-[560px] w-full rounded-2xl border border-slate-200 bg-white" src={previewUrl} /> : <pre className="mt-4 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">{previewText}</pre>) : null}
                </aside>
              </div>
            ) : null}

            {activeTab === "output" ? (
              <div className="grid h-full grid-cols-1 gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
                <aside className="rounded-[28px] border border-slate-200 bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Output mode</p>
                  <div className="mt-4 space-y-3">
                    <button className={clsx("w-full rounded-2xl px-4 py-3 text-sm font-semibold", outputMode === "markdown" ? "bg-slate-950 text-white" : "border border-slate-300 text-slate-700")} onClick={() => setOutputMode("markdown")}>Markdown</button>
                    <button className={clsx("w-full rounded-2xl px-4 py-3 text-sm font-semibold", outputMode === "pdf" ? "bg-slate-950 text-white" : "border border-slate-300 text-slate-700")} onClick={() => setOutputMode("pdf")}>PDF</button>
                  </div>
                </aside>
                <div className="scrollbar-thin h-[calc(100vh-240px)] min-h-[620px] overflow-y-auto rounded-[28px] border border-slate-200 bg-white p-5">
                  {previewError ? <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{previewError}</p> : null}
                  {outputMode === "markdown" ? (latestMarkdownArtifact ? <article className="prose prose-slate max-w-none prose-headings:text-slate-950"><ReactMarkdown>{previewArtifactId === latestMarkdownArtifact.id ? previewText : ""}</ReactMarkdown></article> : <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">No final markdown exists for the selected run.</div>) : latestPdfArtifact ? <iframe className="h-[calc(100vh-300px)] min-h-[560px] w-full rounded-2xl border border-slate-200 bg-white" src={previewArtifactId === latestPdfArtifact.id ? previewUrl : filePreviewPath(latestPdfArtifact.id)} /> : <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">No final PDF exists for the selected run.</div>}
                </div>
              </div>
            ) : null}

            {activeTab === "logs" ? (
              <div className="grid h-full grid-cols-1 gap-5 2xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="rounded-[28px] border border-slate-200 bg-white p-5">
                  <h3 className="text-lg font-semibold text-slate-950">Run summary</h3>
                  {!selectedRun ? <p className="mt-4 text-sm text-slate-500">Select a run to inspect logs.</p> : null}
                  {selectedRun ? (
                    <div className="mt-4 space-y-3 text-sm text-slate-700">
                      <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"><span className="font-medium text-slate-800">Status</span><span className={clsx("rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]", statusTone(selectedRun.status))}>{selectedRun.status}</span></div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Created: {formatDateTime(selectedRun.created_at)}</div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Updated: {formatDateTime(selectedRun.updated_at)}</div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Completed: {formatDateTime(selectedRun.completed_at)}</div>
                      {selectedRun.error_message ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">{selectedRun.error_message}</div> : null}
                    </div>
                  ) : null}
                </aside>

                <div className="scrollbar-thin h-[calc(100vh-240px)] min-h-[620px] overflow-y-auto rounded-[28px] border border-slate-200 bg-white p-5">
                  <section>
                    <h3 className="text-lg font-semibold text-slate-950">Run events</h3>
                    {(selectedRun?.events ?? []).length === 0 ? <p className="mt-4 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">No events recorded for this run.</p> : null}
                    <div className="mt-4 space-y-3">
                      {(selectedRun?.events ?? []).map((event) => (
                        <article key={event.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold text-slate-900">{event.type}</p><span className="text-xs text-slate-500">{formatDateTime(event.created_at)}</span></div>
                          <pre className="mt-3 whitespace-pre-wrap rounded-2xl bg-white p-3 text-xs leading-5 text-slate-700">{JSON.stringify(event.event_json, null, 2)}</pre>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section className="mt-8">
                    <h3 className="text-lg font-semibold text-slate-950">Node execution table</h3>
                    {(selectedRun?.node_executions ?? []).length === 0 ? <p className="mt-4 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">No node execution data yet.</p> : null}
                    {(selectedRun?.node_executions ?? []).length > 0 ? (
                      <div className="mt-4 overflow-x-auto rounded-3xl border border-slate-200">
                        <table className="min-w-full text-left text-sm">
                          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500"><tr><th className="px-4 py-3">Node</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Model</th><th className="px-4 py-3">Input</th><th className="px-4 py-3">Output</th><th className="px-4 py-3">Cost</th><th className="px-4 py-3">Error</th></tr></thead>
                          <tbody>
                            {(selectedRun?.node_executions ?? []).map((node: NodeExecution) => (
                              <tr key={node.id} className="border-t border-slate-200 align-top text-slate-700"><td className="px-4 py-3 font-medium text-slate-900">{node.node_name}</td><td className="px-4 py-3">{node.status}</td><td className="px-4 py-3">{node.model_used ?? node.model_profile ?? "n/a"}</td><td className="px-4 py-3">{node.token_input ?? 0}</td><td className="px-4 py-3">{node.token_output ?? 0}</td><td className="px-4 py-3">{node.cost_estimate != null ? `$${node.cost_estimate.toFixed(4)}` : "n/a"}</td><td className="px-4 py-3 text-red-700">{node.error_message ?? ""}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </section>
                </div>
              </div>
            ) : null}
          </div>

          <footer className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">{isLoadingWorkspace ? "Refreshing workspace data..." : selectedProject ? `Project root: ${selectedProject.r2_root_prefix}` : "No project selected."}</footer>
        </section>
      </div>
    </main>
  );
}


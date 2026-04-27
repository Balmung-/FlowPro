"use client";

import "react18-json-view/src/style.css";
import "reactflow/dist/style.css";

import clsx from "clsx";
import JsonView from "react18-json-view";
import ReactMarkdown from "react-markdown";
import ReactFlow, { Background, Controls, Edge, Node } from "reactflow";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { API_BASE, Artifact, ChatMessage, Project, Run, RunDetail, RunEvent, apiFetch } from "@/lib/api";
import { clearAuthSession, getStoredToken } from "@/lib/auth";

const WORKFLOW_NODES = [
  "intent_parser",
  "requirement_extractor",
  "outline_builder",
  "draft_writer",
  "critic_qa",
  "final_writer",
  "pdf_generator"
];

const TAB_KEYS = ["flow", "data", "files", "output", "logs"] as const;
type TabKey = (typeof TAB_KEYS)[number];

export default function WorkspacePage() {
  const router = useRouter();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeStreamRunIdRef = useRef("");

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("flow");
  const [selectedNodeId, setSelectedNodeId] = useState("intent_parser");
  const [messageInput, setMessageInput] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [outputMode, setOutputMode] = useState<"markdown" | "pdf">("markdown");

  const latestMarkdownArtifact = useMemo(() => files.find((artifact) => artifact.path === "final/output.md"), [files]);
  const latestPdfArtifact = useMemo(() => files.find((artifact) => artifact.path === "final/output.pdf"), [files]);

  const filesByGroup = useMemo(() => {
    return files.reduce<Record<string, Artifact[]>>((accumulator, artifact) => {
      const group = artifact.path.split("/")[0] ?? "other";
      accumulator[group] = accumulator[group] ?? [];
      accumulator[group].push(artifact);
      return accumulator;
    }, {});
  }, [files]);

  const nodeMap = useMemo(() => new Map((selectedRun?.node_executions ?? []).map((node) => [node.node_id, node])), [selectedRun]);
  const selectedNode = nodeMap.get(selectedNodeId) ?? null;

  const previewSelectedArtifact = useCallback(async (artifact: Artifact) => {
    setPreviewArtifact(artifact);
    const { download_url } = await apiFetch<{ download_url: string }>(`/artifacts/${artifact.id}/download-url`);
    setPreviewUrl(download_url);
    if (artifact.mime_type.includes("markdown") || artifact.mime_type.includes("json") || artifact.mime_type.startsWith("text/")) {
      const response = await fetch(download_url);
      setPreviewText(await response.text());
    } else {
      setPreviewText("");
    }
  }, []);

  const flowNodes: Node[] = useMemo(() => {
    return WORKFLOW_NODES.map((nodeId, index) => {
      const execution = nodeMap.get(nodeId);
      const status = execution?.status ?? "waiting";
      const cost = execution?.cost_estimate ? `$${execution.cost_estimate.toFixed(4)}` : "n/a";
      return {
        id: nodeId,
        position: { x: 40, y: index * 130 },
        data: {
          label: (
            <div className="min-w-[220px]">
              <div className="flex items-center justify-between gap-4">
                <span className="font-semibold text-ink">{execution?.node_name ?? nodeId}</span>
                <span className={clsx("rounded-full px-2 py-1 text-xs", {
                  "bg-slate-200 text-slate-700": status === "waiting",
                  "bg-amber-100 text-amber-800": status === "running",
                  "bg-emerald-100 text-emerald-800": status === "completed",
                  "bg-red-100 text-red-800": status === "failed",
                  "bg-slate-300 text-slate-700": status === "skipped"
                })}>
                  {status}
                </span>
              </div>
              <div className="mt-3 space-y-1 text-xs text-slate-500">
                <p>Model: {execution?.model_used ?? execution?.model_profile ?? "n/a"}</p>
                <p>Tokens: {(execution?.token_input ?? 0) + (execution?.token_output ?? 0)}</p>
                <p>Cost: {cost}</p>
              </div>
            </div>
          )
        },
        style: {
          borderRadius: 16,
          border: nodeId === selectedNodeId ? "2px solid #0f172a" : "1px solid #cbd5e1",
          background: "#ffffff",
          boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)"
        }
      };
    });
  }, [nodeMap, selectedNodeId]);

  const flowEdges: Edge[] = useMemo(() => {
    return WORKFLOW_NODES.slice(0, -1).map((nodeId, index) => ({
      id: `${nodeId}-${WORKFLOW_NODES[index + 1]}`,
      source: nodeId,
      target: WORKFLOW_NODES[index + 1],
      type: "smoothstep",
      animated: nodeMap.get(nodeId)?.status === "running"
    }));
  }, [nodeMap]);

  const loadRun = useCallback(async (runId: string) => {
    if (!runId) {
      setSelectedRun(null);
      return;
    }
    const detail = await apiFetch<RunDetail>(`/runs/${runId}`);
    setSelectedRun(detail);
  }, []);

  const loadWorkspace = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }
    const [nextMessages, nextFiles, nextRuns] = await Promise.all([
      apiFetch<ChatMessage[]>(`/projects/${projectId}/messages`),
      apiFetch<Artifact[]>(`/projects/${projectId}/files`),
      apiFetch<Run[]>(`/projects/${projectId}/runs`)
    ]);
    setMessages(nextMessages);
    setFiles(nextFiles);
    setRuns(nextRuns);
    const runToSelect = nextRuns.find((run) => run.id === selectedRunId) ?? nextRuns[0] ?? null;
    if (runToSelect) {
      setSelectedRunId(runToSelect.id);
      await loadRun(runToSelect.id);
    } else {
      setSelectedRunId("");
      setSelectedRun(null);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      activeStreamRunIdRef.current = "";
    }
  }, [loadRun, selectedRunId]);

  const connectRunEvents = useCallback((runId: string, projectId: string) => {
    const token = getStoredToken();
    if (!token) {
      return;
    }
    if (activeStreamRunIdRef.current === runId && eventSourceRef.current && eventSourceRef.current.readyState !== EventSource.CLOSED) {
      return;
    }
    eventSourceRef.current?.close();
    activeStreamRunIdRef.current = runId;
    const source = new EventSource(`${API_BASE}/runs/${runId}/events?token=${encodeURIComponent(token)}`);
    source.onmessage = async (event) => {
      const payload = JSON.parse(event.data) as RunEvent;
      setSelectedRun((current) => current && current.id === runId ? { ...current, events: [...current.events, payload] } : current);
      if (payload.type.startsWith("node.") || payload.type.startsWith("run.") || payload.type === "artifact.created") {
        await loadWorkspace(projectId);
      }
      if (payload.type === "run.completed" || payload.type === "run.failed") {
        source.close();
        if (activeStreamRunIdRef.current === runId) {
          activeStreamRunIdRef.current = "";
          eventSourceRef.current = null;
        }
      }
    };
    source.onerror = () => {
      source.close();
      if (activeStreamRunIdRef.current === runId) {
        activeStreamRunIdRef.current = "";
        eventSourceRef.current = null;
      }
    };
    eventSourceRef.current = source;
  }, [loadWorkspace]);

  const loadProjects = useCallback(async () => {
    const nextProjects = await apiFetch<Project[]>("/projects");
    setProjects(nextProjects);
    const nextProjectId = selectedProjectId || nextProjects[0]?.id || "";
    if (nextProjectId) {
      setSelectedProjectId(nextProjectId);
    }
    return nextProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    if (!getStoredToken()) {
      router.replace("/login");
      return;
    }
    loadProjects()
      .then((projectId) => projectId ? loadWorkspace(projectId) : undefined)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load workspace."));
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      activeStreamRunIdRef.current = "";
    };
  }, [loadProjects, loadWorkspace, router]);

  useEffect(() => {
    if (selectedProjectId) {
      loadWorkspace(selectedProjectId).catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "Failed to refresh workspace.");
      });
    }
  }, [loadWorkspace, selectedProjectId]);

  useEffect(() => {
    const activeRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
    if (activeRun && (activeRun.status === "queued" || activeRun.status === "running")) {
      connectRunEvents(activeRun.id, selectedProjectId);
      return;
    }
    if (activeStreamRunIdRef.current) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      activeStreamRunIdRef.current = "";
    }
  }, [connectRunEvents, runs, selectedProjectId, selectedRunId]);

  useEffect(() => {
    const artifact = outputMode === "markdown" ? latestMarkdownArtifact : latestPdfArtifact;
    if (artifact) {
      previewSelectedArtifact(artifact).catch(() => undefined);
    }
  }, [latestMarkdownArtifact, latestPdfArtifact, outputMode, previewSelectedArtifact]);

  async function createProject() {
    if (!projectName.trim()) {
      return;
    }
    setCreatingProject(true);
    setError(null);
    try {
      const project = await apiFetch<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ name: projectName, description: projectDescription })
      });
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setProjectName("");
      setProjectDescription("");
      await loadWorkspace(project.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Project creation failed.");
    } finally {
      setCreatingProject(false);
    }
  }

  async function runWorkflow() {
    if (!selectedProjectId || !messageInput.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const run = await apiFetch<Run>(`/projects/${selectedProjectId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input_message: messageInput })
      });
      setMessageInput("");
      setActiveTab("flow");
      setSelectedRunId(run.id);
      await loadWorkspace(selectedProjectId);
      connectRunEvents(run.id, selectedProjectId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (!selectedProjectId || selectedFiles.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const file of selectedFiles) {
        const relativePath = `input/${file.name}`;
        const { upload_url } = await apiFetch<{ upload_url: string }>(`/projects/${selectedProjectId}/files/upload-url`, {
          method: "POST",
          body: JSON.stringify({ relative_path: relativePath, mime_type: file.type || "application/octet-stream" })
        });
        const uploadResponse = await fetch(upload_url, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file
        });
        if (!uploadResponse.ok) {
          throw new Error(`Upload failed for ${file.name}`);
        }
        await apiFetch(`/projects/${selectedProjectId}/files/confirm-upload`, {
          method: "POST",
          body: JSON.stringify({
            relative_path: relativePath,
            filename: file.name,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size
          })
        });
      }
      await loadWorkspace(selectedProjectId);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "File upload failed.");
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  }

  async function downloadArtifact(artifact: Artifact) {
    const { download_url } = await apiFetch<{ download_url: string }>(`/artifacts/${artifact.id}/download-url`);
    window.open(download_url, "_blank");
  }

  async function deleteArtifact(artifact: Artifact) {
    await apiFetch(`/artifacts/${artifact.id}`, { method: "DELETE" });
    await loadWorkspace(selectedProjectId);
  }

  function signOut() {
    clearAuthSession();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    activeStreamRunIdRef.current = "";
    router.push("/login");
  }

  return (
    <main className="min-h-screen p-4 md:p-6">
      <div className="grid min-h-[calc(100vh-2rem)] grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="flex flex-col rounded-3xl border border-edge bg-white/95 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">FlowPro</p>
              <h1 className="text-xl font-semibold text-ink">Document cockpit</h1>
            </div>
            <button className="rounded-xl border border-edge px-3 py-2 text-sm" onClick={signOut}>Logout</button>
          </div>

          <div className="mt-6 space-y-3">
            <label className="block text-sm font-medium text-slate-700">Project selector</label>
            <select className="w-full rounded-xl border border-edge bg-white px-3 py-2" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>

          <div className="mt-4 rounded-2xl border border-edge bg-panel p-4">
            <p className="text-sm font-medium text-ink">Create project</p>
            <input className="mt-3 w-full rounded-xl border border-edge bg-white px-3 py-2 text-sm" placeholder="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            <textarea className="mt-3 min-h-[88px] w-full rounded-xl border border-edge bg-white px-3 py-2 text-sm" placeholder="Description" value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} />
            <button className="mt-3 w-full rounded-xl bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={createProject} disabled={creatingProject}>
              {creatingProject ? "Creating..." : "Create project"}
            </button>
          </div>

          <div className="mt-6 flex-1 overflow-hidden rounded-2xl border border-edge">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="text-sm font-medium text-ink">Chat history</h2>
            </div>
            <div className="scrollbar-thin h-[280px] space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? <p className="text-sm text-slate-500">No messages yet.</p> : null}
              {messages.map((message) => (
                <div key={message.id} className={clsx("rounded-2xl px-4 py-3 text-sm", {
                  "bg-slate-900 text-white": message.role === "user",
                  "bg-slate-100 text-slate-800": message.role === "assistant",
                  "bg-amber-50 text-amber-900": message.role === "system"
                })}>
                  <div className="mb-2 text-xs uppercase tracking-wide opacity-70">{message.role}</div>
                  <div className="whitespace-pre-wrap">{message.content}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <textarea className="min-h-[120px] w-full rounded-2xl border border-edge bg-white px-4 py-3 text-sm" placeholder="Describe the document to generate..." value={messageInput} onChange={(event) => setMessageInput(event.target.value)} />
            <div className="mt-3 flex gap-3">
              <input className="hidden" multiple ref={uploadRef} type="file" onChange={handleUpload} />
              <button className="flex-1 rounded-xl border border-edge px-4 py-3 text-sm font-medium" onClick={() => uploadRef.current?.click()}>
                Upload file
              </button>
              <button className="flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white disabled:opacity-60" onClick={runWorkflow} disabled={busy || !selectedProjectId}>
                {busy ? "Running..." : "Run"}
              </button>
            </div>
          </div>

          {error ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </aside>

        <section className="flex min-h-0 flex-col rounded-3xl border border-edge bg-white/95 p-4 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-edge pb-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Workspace</p>
              <h2 className="text-xl font-semibold text-ink">{projects.find((project) => project.id === selectedProjectId)?.name ?? "No project selected"}</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <select className="rounded-xl border border-edge px-3 py-2 text-sm" value={selectedRunId} onChange={(event) => {
                setSelectedRunId(event.target.value);
                loadRun(event.target.value).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Run load failed."));
              }}>
                <option value="">No run selected</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>{run.id} - {run.status}</option>
                ))}
              </select>
              {TAB_KEYS.map((tab) => (
                <button
                  key={tab}
                  className={clsx("rounded-xl px-4 py-2 text-sm font-medium capitalize", activeTab === tab ? "bg-ink text-white" : "border border-edge text-slate-700")}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === "data" ? "Data Inspector" : tab === "flow" ? "Node Flow" : tab === "output" ? "Output Viewer" : tab}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-hidden">
            {activeTab === "flow" ? (
              <div className="grid h-full grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="h-[640px] rounded-2xl border border-edge bg-slate-50">
                  <ReactFlow nodes={flowNodes} edges={flowEdges} fitView onNodeClick={(_, node) => setSelectedNodeId(node.id)} proOptions={{ hideAttribution: true }}>
                    <Background color="#dbeafe" gap={24} />
                    <Controls />
                  </ReactFlow>
                </div>
                <div className="scrollbar-thin h-[640px] overflow-y-auto rounded-2xl border border-edge bg-white p-4">
                  <h3 className="text-lg font-semibold text-ink">{selectedNode?.node_name ?? "Node details"}</h3>
                  <div className="mt-4 space-y-4">
                    <div className="rounded-2xl border border-edge p-4">
                      <p className="text-sm font-medium text-ink">Status</p>
                      <p className="mt-2 text-sm text-slate-600">{selectedNode?.status ?? "waiting"}</p>
                      <p className="mt-2 text-sm text-slate-600">Model: {selectedNode?.model_used ?? selectedNode?.model_profile ?? "n/a"}</p>
                      <p className="mt-2 text-sm text-slate-600">Tokens: {(selectedNode?.token_input ?? 0) + (selectedNode?.token_output ?? 0)}</p>
                      <p className="mt-2 text-sm text-slate-600">Cost: {selectedNode?.cost_estimate ? `$${selectedNode.cost_estimate.toFixed(4)}` : "n/a"}</p>
                    </div>
                    <div className="rounded-2xl border border-edge p-4">
                      <p className="text-sm font-medium text-ink">Input JSON</p>
                      <div className="mt-3 overflow-auto text-xs"><JsonView src={selectedNode?.input_json ?? {}} /></div>
                    </div>
                    <div className="rounded-2xl border border-edge p-4">
                      <p className="text-sm font-medium text-ink">Output JSON</p>
                      <div className="mt-3 overflow-auto text-xs"><JsonView src={selectedNode?.output_json ?? {}} /></div>
                    </div>
                    <div className="rounded-2xl border border-edge p-4">
                      <p className="text-sm font-medium text-ink">Timestamps</p>
                      <p className="mt-2 text-sm text-slate-600">Started: {selectedNode?.started_at ?? "n/a"}</p>
                      <p className="mt-2 text-sm text-slate-600">Completed: {selectedNode?.completed_at ?? "n/a"}</p>
                      {selectedNode?.error_message ? <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{selectedNode.error_message}</p> : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === "data" ? (
              <div className="scrollbar-thin h-full overflow-auto rounded-2xl border border-edge bg-white p-4">
                <JsonView collapsed={2} src={selectedRun?.state_json ?? {}} />
              </div>
            ) : null}

            {activeTab === "files" ? (
              <div className="grid h-full grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <div className="scrollbar-thin h-[640px] overflow-y-auto rounded-2xl border border-edge bg-white p-4">
                  {["input", "working", "final", "logs", "archive"].map((group) => (
                    <div key={group} className="mb-6">
                      <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">{group}</h3>
                      <div className="space-y-3">
                        {(filesByGroup[group] ?? []).map((artifact) => (
                          <div key={artifact.id} className="rounded-2xl border border-edge p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className="font-medium text-ink">{artifact.filename}</p>
                                <p className="mt-1 text-xs text-slate-500">{artifact.path}</p>
                                <p className="mt-1 text-xs text-slate-500">{artifact.mime_type} - {artifact.size_bytes} bytes</p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button className="rounded-lg border border-edge px-3 py-1 text-xs" onClick={() => previewSelectedArtifact(artifact).catch(() => undefined)}>Preview</button>
                                <button className="rounded-lg border border-edge px-3 py-1 text-xs" onClick={() => downloadArtifact(artifact)}>Download</button>
                                <button className="rounded-lg border border-edge px-3 py-1 text-xs" onClick={() => navigator.clipboard.writeText(artifact.path)}>Copy path</button>
                                <button className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-700" onClick={() => deleteArtifact(artifact)}>Delete</button>
                              </div>
                            </div>
                          </div>
                        ))}
                        {(filesByGroup[group] ?? []).length === 0 ? <p className="text-sm text-slate-500">No files.</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="scrollbar-thin h-[640px] overflow-y-auto rounded-2xl border border-edge bg-white p-4">
                  <h3 className="text-lg font-semibold text-ink">Preview</h3>
                  {previewArtifact ? (
                    <div className="mt-4">
                      <p className="text-sm font-medium text-ink">{previewArtifact.filename}</p>
                      <p className="mt-1 text-xs text-slate-500">{previewArtifact.path}</p>
                      {previewArtifact.mime_type.includes("pdf") ? (
                        <iframe className="mt-4 h-[520px] w-full rounded-xl border border-edge" src={previewUrl} />
                      ) : (
                        <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm text-slate-700">{previewText || "Binary preview not available."}</pre>
                      )}
                    </div>
                  ) : <p className="mt-4 text-sm text-slate-500">Select a file to preview.</p>}
                </div>
              </div>
            ) : null}

            {activeTab === "output" ? (
              <div className="grid h-full grid-cols-1 gap-4 xl:grid-cols-[160px_minmax(0,1fr)]">
                <div className="rounded-2xl border border-edge bg-white p-3">
                  <button className={clsx("mb-2 w-full rounded-xl px-4 py-3 text-sm font-medium", outputMode === "markdown" ? "bg-ink text-white" : "border border-edge")} onClick={() => setOutputMode("markdown")}>Markdown</button>
                  <button className={clsx("w-full rounded-xl px-4 py-3 text-sm font-medium", outputMode === "pdf" ? "bg-ink text-white" : "border border-edge")} onClick={() => setOutputMode("pdf")}>PDF</button>
                </div>
                <div className="scrollbar-thin h-[640px] overflow-y-auto rounded-2xl border border-edge bg-white p-4">
                  {outputMode === "markdown" ? (
                    latestMarkdownArtifact ? <article className="max-w-none prose prose-slate"><ReactMarkdown>{previewArtifact?.id === latestMarkdownArtifact.id ? previewText : ""}</ReactMarkdown></article> : <p className="text-sm text-slate-500">No final markdown yet.</p>
                  ) : (
                    latestPdfArtifact ? <iframe className="h-full min-h-[580px] w-full rounded-xl border border-edge" src={previewArtifact?.id === latestPdfArtifact.id ? previewUrl : ""} /> : <p className="text-sm text-slate-500">No final PDF yet.</p>
                  )}
                </div>
              </div>
            ) : null}

            {activeTab === "logs" ? (
              <div className="grid h-full grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
                <div className="rounded-2xl border border-edge bg-white p-4">
                  <h3 className="text-lg font-semibold text-ink">Run summary</h3>
                  <p className="mt-4 text-sm text-slate-600">Status: {selectedRun?.status ?? "n/a"}</p>
                  <p className="mt-2 text-sm text-slate-600">Created: {selectedRun?.created_at ?? "n/a"}</p>
                  <p className="mt-2 text-sm text-slate-600">Updated: {selectedRun?.updated_at ?? "n/a"}</p>
                  <p className="mt-2 text-sm text-slate-600">Completed: {selectedRun?.completed_at ?? "n/a"}</p>
                  {selectedRun?.error_message ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{selectedRun.error_message}</p> : null}
                </div>
                <div className="scrollbar-thin h-[640px] overflow-y-auto rounded-2xl border border-edge bg-white p-4">
                  <h3 className="text-lg font-semibold text-ink">Events</h3>
                  <div className="mt-4 space-y-3">
                    {(selectedRun?.events ?? []).map((event) => (
                      <div key={event.id} className="rounded-2xl border border-edge p-4">
                        <div className="flex items-center justify-between gap-4">
                          <p className="font-medium text-ink">{event.type}</p>
                          <span className="text-xs text-slate-500">{event.created_at}</span>
                        </div>
                        <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs text-slate-700">{JSON.stringify(event.event_json, null, 2)}</pre>
                      </div>
                    ))}
                  </div>
                  <h3 className="mt-6 text-lg font-semibold text-ink">Node execution table</h3>
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="text-slate-500">
                        <tr>
                          <th className="pb-2">Node</th>
                          <th className="pb-2">Status</th>
                          <th className="pb-2">Model</th>
                          <th className="pb-2">Tokens</th>
                          <th className="pb-2">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(selectedRun?.node_executions ?? []).map((node) => (
                          <tr key={node.id} className="border-t border-edge">
                            <td className="py-3">{node.node_name}</td>
                            <td className="py-3">{node.status}</td>
                            <td className="py-3">{node.model_used ?? node.model_profile ?? "n/a"}</td>
                            <td className="py-3">{(node.token_input ?? 0) + (node.token_output ?? 0)}</td>
                            <td className="py-3">{node.cost_estimate ? `$${node.cost_estimate.toFixed(4)}` : "n/a"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

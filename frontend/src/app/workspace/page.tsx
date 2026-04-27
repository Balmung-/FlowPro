"use client";

import "react18-json-view/src/style.css";

import clsx from "clsx";
import JsonView from "react18-json-view";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  API_BASE,
  Artifact,
  ChatMessage,
  NodeExecution,
  Project,
  Run,
  RunDetail,
  RunEvent,
  Template,
  TemplateNodeConfig,
  User,
  ViewerKind,
  apiFetch,
} from "@/lib/api";
import { clearAuthSession, getStoredToken } from "@/lib/auth";
import FileExplorerDrawer from "@/components/file-explorer-drawer";
import DeleteProjectModal from "@/components/delete-project-modal";

const STREAM_EVENT_TYPES = [
  "run.started",
  "node.started",
  "node.completed",
  "node.failed",
  "artifact.created",
  "run.completed",
  "run.failed",
  "run.paused",
];

const TAB_KEYS = ["flow", "data", "files", "output", "logs"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  flow: "Node Flow",
  data: "Data Inspector",
  files: "Files",
  output: "Output Viewer",
  logs: "Logs",
};

const VIEWER_LABELS: Record<ViewerKind, string> = {
  markdown: "Markdown",
  pdf: "PDF",
  json: "JSON",
  raw: "Raw",
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
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
    case "queued":
      return "bg-blue-100 text-blue-900 border border-blue-200";
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
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("flow");
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [messageInput, setMessageInput] = useState("");
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectTemplateId, setProjectTemplateId] = useState("");
  const [previewArtifactId, setPreviewArtifactId] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewIsPdf, setPreviewIsPdf] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [outputViewer, setOutputViewer] = useState<ViewerKind>("markdown");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerInitialTab, setExplorerInitialTab] = useState<"project" | "vault">("project");
  const [me, setMe] = useState<User | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const activeTemplate = useMemo<Template | null>(() => {
    if (!selectedProject?.template_id) return null;
    return templates.find((tpl) => tpl.id === selectedProject.template_id) ?? null;
  }, [selectedProject, templates]);

  const templateNodes: TemplateNodeConfig[] = useMemo(
    () => activeTemplate?.config_json?.nodes ?? [],
    [activeTemplate]
  );

  const allowedViewers: ViewerKind[] = useMemo(() => {
    const list = activeTemplate?.config_json?.allowed_viewers ?? ["markdown", "pdf", "json"];
    return list.length ? list : ["markdown", "pdf", "json"];
  }, [activeTemplate]);

  // Initialize default viewer when template changes.
  useEffect(() => {
    const fallback = activeTemplate?.config_json?.default_viewer ?? allowedViewers[0] ?? "markdown";
    if (!allowedViewers.includes(outputViewer)) {
      setOutputViewer(fallback);
    }
  }, [activeTemplate, allowedViewers, outputViewer]);

  const selectedRunSummary = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? selectedRun ?? null,
    [runs, selectedRun, selectedRunId]
  );
  const selectedRunActive =
    selectedRunSummary?.status === "queued" || selectedRunSummary?.status === "running";
  const isRunInProgress = useMemo(
    () => runs.some((run) => run.status === "queued" || run.status === "running"),
    [runs]
  );

  // Extract the *logical* section from an artifact path. Run-scoped artifacts
  // live at "runs/<run_id>/<section>/...", project-wide ones (uploads) at
  // "<section>/...". This collapses both shapes to the section name.
  const logicalSection = useCallback((path: string): string | null => {
    if (path.startsWith("runs/")) {
      const parts = path.split("/");
      return parts[2] ?? null;
    }
    return path.split("/")[0] ?? null;
  }, []);

  const filesByGroup = useMemo(() => {
    const grouped = {
      input: [] as Artifact[],
      working: [] as Artifact[],
      final: [] as Artifact[],
      logs: [] as Artifact[],
      archive: [] as Artifact[],
    };
    for (const artifact of files) {
      // Files tab in the inspector is run-scoped — only show the selected
      // run's artifacts (plus project uploads in input/, which aren't tied
      // to any run).
      const isProjectUpload = artifact.run_id === null;
      const isThisRun = selectedRunId && artifact.run_id === selectedRunId;
      if (!isProjectUpload && !isThisRun) continue;
      const section = logicalSection(artifact.path);
      if (section && section in grouped) {
        grouped[section as keyof typeof grouped].push(artifact);
      }
    }
    return grouped;
  }, [files, selectedRunId, logicalSection]);

  const activeRunArtifacts = useMemo(
    () => (selectedRun?.artifacts ?? []).filter((artifact) => artifact.deleted_at === null),
    [selectedRun]
  );
  // Resolve the run's final outputs by filename suffix. Path is
  // runs/<run_id>/final/output.md (new) or final/output.md (legacy pre-immutability).
  const latestMarkdownArtifact = useMemo(
    () =>
      activeRunArtifacts.find(
        (artifact) =>
          artifact.run_id === selectedRunId &&
          (artifact.path === "final/output.md" || artifact.path.endsWith("/final/output.md"))
      ) ?? null,
    [activeRunArtifacts, selectedRunId]
  );
  const latestPdfArtifact = useMemo(
    () =>
      activeRunArtifacts.find(
        (artifact) =>
          artifact.run_id === selectedRunId &&
          (artifact.path === "final/output.pdf" || artifact.path.endsWith("/final/output.pdf"))
      ) ?? null,
    [activeRunArtifacts, selectedRunId]
  );

  const nodeExecutions = useMemo(
    () => new Map((selectedRun?.node_executions ?? []).map((node) => [node.node_id, node])),
    [selectedRun]
  );
  const selectedNode = nodeExecutions.get(selectedNodeId) ?? null;
  const selectedNodeConfig = useMemo<TemplateNodeConfig | null>(
    () => templateNodes.find((node) => node.id === selectedNodeId) ?? null,
    [templateNodes, selectedNodeId]
  );

  const loadRunDetail = useCallback(async (runId: string) => {
    if (!runId) {
      setSelectedRun(null);
      return null;
    }
    const detail = await apiFetch<RunDetail>(`/runs/${runId}`);
    setSelectedRun(detail);
    return detail;
  }, []);

  const loadProjects = useCallback(async () => {
    const projectList = await apiFetch<Project[]>("/projects");
    setProjects(projectList);
    setSelectedProjectId((current) =>
      current && projectList.some((project) => project.id === current)
        ? current
        : projectList[0]?.id ?? ""
    );
  }, []);

  const loadTemplates = useCallback(async () => {
    const list = await apiFetch<Template[]>("/templates");
    setTemplates(list);
    setProjectTemplateId((current) => {
      if (current && list.some((tpl) => tpl.id === current)) return current;
      const docGen = list.find((tpl) => tpl.slug === "document_generator");
      return docGen?.id ?? list[0]?.id ?? "";
    });
  }, []);

  // Heavy refresh: pulls every project-scoped collection. Used on first load
  // of a project, after creating a run, after uploading/deleting files. NOT
  // used during live SSE streaming (which uses lighter targeted refreshes).
  const loadProjectData = useCallback(
    async (projectId: string, preferredRunId?: string) => {
      if (!projectId) {
        setMessages([]);
        setFiles([]);
        setRuns([]);
        setSelectedRunId("");
        setSelectedRun(null);
        return;
      }
      const [nextFiles, nextRuns] = await Promise.all([
        apiFetch<Artifact[]>(`/projects/${projectId}/files`),
        apiFetch<Run[]>(`/projects/${projectId}/runs`),
      ]);
      setFiles(nextFiles);
      setRuns(nextRuns);
      const runIdToSelect =
        preferredRunId && nextRuns.some((run) => run.id === preferredRunId)
          ? preferredRunId
          : selectedRunId && nextRuns.some((run) => run.id === selectedRunId)
            ? selectedRunId
            : nextRuns[0]?.id ?? "";
      setSelectedRunId(runIdToSelect);
      if (runIdToSelect) {
        await loadRunDetail(runIdToSelect);
      } else {
        setSelectedRun(null);
      }
      // Chat thread is run-scoped; load it via the dedicated effect that
      // re-runs whenever selectedRunId changes (see below).
      if (!runIdToSelect) {
        setMessages([]);
      }
    },
    [loadRunDetail, selectedRunId]
  );

  // Light refresh: just the runs list. Called on terminal SSE events so the
  // sidebar reflects the latest status without re-fetching files/messages.
  const refreshRunsList = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const nextRuns = await apiFetch<Run[]>(`/projects/${projectId}/runs`);
    setRuns(nextRuns);
  }, []);

  // Light refresh: project files (used after a run completes so the Files
  // tab and the explorer drawer pick up newly-written artifacts).
  const refreshProjectFiles = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const nextFiles = await apiFetch<Artifact[]>(`/projects/${projectId}/files`);
    setFiles(nextFiles);
  }, []);

  const loadArtifactPreview = useCallback(async (artifact: Artifact) => {
    setPreviewArtifactId(artifact.id);
    setPreviewError(null);
    const contentUrl = filePreviewPath(artifact.id);
    setPreviewUrl(contentUrl);
    const isPdf = artifact.mime_type.includes("pdf");
    setPreviewIsPdf(isPdf);
    if (isPdf) {
      setPreviewText("");
      return;
    }
    if (
      artifact.mime_type.startsWith("text/") ||
      artifact.mime_type.includes("json") ||
      artifact.mime_type.includes("markdown")
    ) {
      const response = await fetch(contentUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`Preview failed for ${artifact.filename}`);
      setPreviewText(await response.text());
      return;
    }
    setPreviewText("Binary preview is not available for this file type.");
  }, []);

  // Bootstrap: auth, projects, templates.
  useEffect(() => {
    if (!getStoredToken()) {
      router.replace("/login");
      return;
    }
    loadProjects().catch((err) => setError(err instanceof Error ? err.message : "Failed to load projects."));
    loadTemplates().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load templates.")
    );
    apiFetch<User>("/auth/me")
      .then(setMe)
      .catch(() => undefined);
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      seenEventIdsRef.current.clear();
    };
  }, [loadProjects, loadTemplates, router]);

  // When project changes, load its data.
  useEffect(() => {
    if (!selectedProjectId) {
      setMessages([]);
      setFiles([]);
      setRuns([]);
      setSelectedRunId("");
      setSelectedRun(null);
      return;
    }
    loadProjectData(selectedProjectId).catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load project workspace.")
    );
  }, [loadProjectData, selectedProjectId]);

  // When the active template's nodes change and a node is unselected (or now-invalid), pick the first.
  useEffect(() => {
    if (templateNodes.length === 0) {
      setSelectedNodeId("");
      return;
    }
    if (!templateNodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(templateNodes[0].id);
    }
  }, [templateNodes, selectedNodeId]);

  // Run-scoped chat: whenever the selected run changes, refetch the messages
  // for that run only. The center pane therefore reflects the same run as
  // the right inspector — no more cross-run conversation soup.
  useEffect(() => {
    if (!selectedProjectId) {
      setMessages([]);
      return;
    }
    if (!selectedRunId) {
      setMessages([]);
      return;
    }
    apiFetch<ChatMessage[]>(
      `/projects/${selectedProjectId}/messages?run_id=${encodeURIComponent(selectedRunId)}`
    )
      .then(setMessages)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load chat for this run.");
      });
  }, [selectedProjectId, selectedRunId]);

  // SSE for the selected run.
  useEffect(() => {
    if (!selectedProjectId || !selectedRunId) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      seenEventIdsRef.current.clear();
      return;
    }
    const token = getStoredToken();
    if (!token) return;

    eventSourceRef.current?.close();
    seenEventIdsRef.current = new Set();

    const source = new EventSource(
      `${API_BASE}/runs/${selectedRunId}/events?token=${encodeURIComponent(token)}`
    );
    eventSourceRef.current = source;

    const TERMINAL_EVENTS = new Set([
      "run.completed",
      "run.failed",
      "run.cancelled",
      "run.paused",
    ]);

    const handleStreamMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as RunEvent;
        if (seenEventIdsRef.current.has(payload.id)) return;
        seenEventIdsRef.current.add(payload.id);

        // Optimistically append the event to the in-memory run detail so
        // the Logs tab updates instantly; the next loadRunDetail will
        // dedupe on event.id.
        setSelectedRun((current) =>
          !current || current.id !== selectedRunId || current.events.some((item) => item.id === payload.id)
            ? current
            : { ...current, events: [...current.events, payload] }
        );

        // Targeted refresh: every event refreshes the run detail (single
        // API call carrying artifacts + node_executions + events). We do
        // NOT reload the whole project on every event anymore.
        loadRunDetail(selectedRunId).catch(() => undefined);

        // On terminal events, also refresh the runs list (sidebar status)
        // and project files (so the Files tab + explorer drawer pick up
        // newly-written run artifacts), and re-fetch this run's chat
        // (so the assistant/system completion message appears).
        if (TERMINAL_EVENTS.has(payload.type)) {
          refreshRunsList(selectedProjectId).catch(() => undefined);
          refreshProjectFiles(selectedProjectId).catch(() => undefined);
          apiFetch<ChatMessage[]>(
            `/projects/${selectedProjectId}/messages?run_id=${encodeURIComponent(selectedRunId)}`
          )
            .then(setMessages)
            .catch(() => undefined);
        }

        // Don't close the stream on `run.paused` — a Continue might
        // re-emit events on the same run.
        if (payload.type === "run.completed" || payload.type === "run.failed" || payload.type === "run.cancelled") {
          source.close();
          if (eventSourceRef.current === source) eventSourceRef.current = null;
        }
      } catch (streamError) {
        setError(
          streamError instanceof Error ? streamError.message : "Failed to process live run event."
        );
      }
    };

    for (const eventType of STREAM_EVENT_TYPES) {
      source.addEventListener(eventType, handleStreamMessage as EventListener);
    }
    source.onmessage = handleStreamMessage;

    return () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [loadRunDetail, refreshProjectFiles, refreshRunsList, selectedProjectId, selectedRunId]);

  // Auto-load preview when output viewer or artifacts change.
  useEffect(() => {
    let outputArtifact: Artifact | null = null;
    if (outputViewer === "markdown") outputArtifact = latestMarkdownArtifact;
    else if (outputViewer === "pdf") outputArtifact = latestPdfArtifact;
    else outputArtifact = latestMarkdownArtifact ?? latestPdfArtifact;

    if (!outputArtifact) {
      if (activeTab === "output") {
        setPreviewArtifactId("");
        setPreviewText("");
        setPreviewUrl("");
        setPreviewIsPdf(false);
      }
      return;
    }
    loadArtifactPreview(outputArtifact).catch((err) => {
      setPreviewError(err instanceof Error ? err.message : "Output preview failed.");
    });
  }, [activeTab, latestMarkdownArtifact, latestPdfArtifact, loadArtifactPreview, outputViewer]);

  // Auto-scroll chat to bottom on new messages.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selectedRun?.status]);

  async function handleCreateProject() {
    if (!projectName.trim()) return;
    setIsCreatingProject(true);
    setError(null);
    try {
      const project = await apiFetch<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: projectName.trim(),
          description: projectDescription.trim(),
          template_id: projectTemplateId || null,
        }),
      });
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setProjectName("");
      setProjectDescription("");
      setShowCreateProject(false);
      setSelectedProjectId(project.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Project creation failed.");
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function handleRunWorkflow() {
    if (!selectedProjectId || !messageInput.trim()) return;
    setIsStartingRun(true);
    setError(null);
    try {
      const run = await apiFetch<Run>(`/projects/${selectedProjectId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input_message: messageInput.trim() }),
      });
      setMessageInput("");
      setActiveTab("flow");
      setSelectedRunId(run.id);
      await loadProjectData(selectedProjectId, run.id);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run creation failed.");
    } finally {
      setIsStartingRun(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (!selectedProjectId || selectedFiles.length === 0) return;

    setIsUploadingFiles(true);
    setError(null);
    try {
      for (const file of selectedFiles) {
        const relativePath = `input/${file.name}`;
        const { upload_url } = await apiFetch<{ upload_url: string }>(
          `/projects/${selectedProjectId}/files/upload-url`,
          {
            method: "POST",
            body: JSON.stringify({
              relative_path: relativePath,
              mime_type: file.type || "application/octet-stream",
            }),
          }
        );
        const uploadResponse = await fetch(upload_url, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!uploadResponse.ok) throw new Error(`Upload failed for ${file.name}`);
        await apiFetch(`/projects/${selectedProjectId}/files/confirm-upload`, {
          method: "POST",
          body: JSON.stringify({
            relative_path: relativePath,
            filename: file.name,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size,
          }),
        });
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
    setSelectedRunId(runId);
    setError(null);
    if (!runId) {
      setSelectedRun(null);
      return;
    }
    try {
      await loadRunDetail(runId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Run load failed.");
    }
  }

  async function handleDownload(artifact: Artifact) {
    const { download_url } = await apiFetch<{ download_url: string }>(
      `/artifacts/${artifact.id}/download-url`
    );
    window.open(download_url, "_blank", "noopener,noreferrer");
  }

  async function handleDelete(artifact: Artifact) {
    setError(null);
    try {
      await apiFetch(`/artifacts/${artifact.id}`, { method: "DELETE" });
      if (previewArtifactId === artifact.id) {
        setPreviewArtifactId("");
        setPreviewText("");
        setPreviewUrl("");
        setPreviewIsPdf(false);
      }
      if (selectedProjectId) await loadProjectData(selectedProjectId, selectedRunId || undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Delete failed.");
    }
  }

  async function handleSetStopPoint(nodeId: string) {
    if (!selectedRunId) return;
    setError(null);
    try {
      const updated = await apiFetch<Run>(`/runs/${selectedRunId}`, {
        method: "PATCH",
        body: JSON.stringify({ stop_after_node_id: nodeId }),
      });
      // Refresh both the run summary and the detailed run state.
      setSelectedRun((current) =>
        current && current.id === updated.id ? { ...current, ...updated } : current
      );
      setRuns((current) =>
        current.map((run) => (run.id === updated.id ? { ...run, ...updated } : run))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set stop point.");
    }
  }

  async function handleClearStopPoint() {
    if (!selectedRunId) return;
    setError(null);
    try {
      const updated = await apiFetch<Run>(`/runs/${selectedRunId}`, {
        method: "PATCH",
        body: JSON.stringify({ stop_after_node_id: null }),
      });
      setSelectedRun((current) =>
        current && current.id === updated.id ? { ...current, ...updated } : current
      );
      setRuns((current) =>
        current.map((run) => (run.id === updated.id ? { ...run, ...updated } : run))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear stop point.");
    }
  }

  async function handleContinueRun() {
    if (!selectedRunId) return;
    setError(null);
    try {
      await apiFetch<Run>(`/runs/${selectedRunId}/continue`, { method: "POST" });
      if (selectedProjectId) {
        await loadProjectData(selectedProjectId, selectedRunId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to continue run.");
    }
  }

  async function handleSaveToVault(artifact: Artifact) {
    setError(null);
    const folder = window.prompt("Save to vault folder (e.g. /Proposals or just /)", "/");
    if (folder === null) return;
    try {
      await apiFetch("/vault/from-artifact", {
        method: "POST",
        body: JSON.stringify({
          artifact_id: artifact.id,
          name: artifact.filename,
          folder: folder.trim() || "/",
          notes: selectedProject ? `From project ${selectedProject.name} · ${artifact.path}` : "",
        }),
      });
      // Briefly open the explorer on the vault tab so the user sees it landed.
      setExplorerInitialTab("vault");
      setExplorerOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save to vault failed.");
    }
  }

  function handleSignOut() {
    clearAuthSession();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    seenEventIdsRef.current.clear();
    router.push("/login");
  }

  const composerDisabled = !selectedProjectId || !messageInput.trim() || isStartingRun || isRunInProgress;

  const showMockBanner = me?.mock_ai_enabled === true;
  const showMissingKeyBanner =
    me && me.mock_ai_enabled === false && me.openrouter_configured === false;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      {showMockBanner ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span>
            <span className="font-semibold">⚠ Mock AI mode is on</span> — every node returns a
            canned response without calling OpenRouter. Outputs are fake. To use real models, set
            <span className="mx-1 rounded bg-white px-1 py-0.5 font-mono text-[11px] text-amber-800">MOCK_AI=false</span>
            on the api and worker services and redeploy.
          </span>
        </div>
      ) : null}
      {showMissingKeyBanner ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-900">
          <span>
            <span className="font-semibold">⚠ OPENROUTER_API_KEY is not set.</span> Real-mode runs
            will fail until you add the key to the api and worker services.
          </span>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_440px]">
        {/* LEFT SIDEBAR — navigation & history */}
        <aside className="flex h-full min-h-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500">FlowPro</p>
              <h1 className="mt-1 text-lg font-semibold text-slate-950">Document Cockpit</h1>
            </div>
            <button
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              onClick={handleSignOut}
            >
              Logout
            </button>
          </div>

          <div className="space-y-2 border-b border-slate-200 px-5 py-4">
            <Link
              className="flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-900 shadow-sm hover:bg-blue-100"
              href="/templates"
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>⚙︎</span>
                Templates &amp; nodes
              </span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-blue-700">
                {templates.length}
              </span>
            </Link>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 shadow-sm hover:bg-emerald-100"
              onClick={() => {
                setExplorerInitialTab("project");
                setExplorerOpen(true);
              }}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>📁</span>
                Files &amp; Vault
              </span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                Open
              </span>
            </button>
            <p className="text-[10px] leading-tight text-slate-500">
              Browse this project's files. Save anything to your permanent Vault before deleting the
              project.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                Projects
              </h2>
              <button
                className="text-xs font-medium text-blue-600 hover:underline"
                onClick={() => setShowCreateProject((value) => !value)}
              >
                {showCreateProject ? "Cancel" : "New"}
              </button>
            </div>

            {showCreateProject ? (
              <div className="mx-3 mb-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <input
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  placeholder="Project name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
                <textarea
                  className="mt-2 min-h-[60px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  placeholder="Description (optional)"
                  value={projectDescription}
                  onChange={(event) => setProjectDescription(event.target.value)}
                />
                <select
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={projectTemplateId}
                  onChange={(event) => setProjectTemplateId(event.target.value)}
                >
                  <option value="">Default template</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                      {tpl.is_seeded ? " (seeded)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  className="mt-2 w-full rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={isCreatingProject || !projectName.trim()}
                  onClick={handleCreateProject}
                >
                  {isCreatingProject ? "Creating…" : "Create project"}
                </button>
              </div>
            ) : null}

            <ul className="space-y-1 px-3 pb-2">
              {projects.length === 0 ? (
                <li className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-xs text-slate-500">
                  No projects yet. Click <span className="font-semibold">New</span> to create one.
                </li>
              ) : null}
              {projects.map((project) => {
                const tpl = templates.find((t) => t.id === project.template_id);
                return (
                  <li key={project.id}>
                    <button
                      className={clsx(
                        "block w-full rounded-xl px-3 py-2 text-left text-sm transition",
                        project.id === selectedProjectId
                          ? "bg-slate-900 text-white"
                          : "text-slate-700 hover:bg-slate-100"
                      )}
                      onClick={() => setSelectedProjectId(project.id)}
                    >
                      <span className="block truncate font-medium">{project.name}</span>
                      <span
                        className={clsx(
                          "block truncate text-[11px]",
                          project.id === selectedProjectId ? "text-slate-300" : "text-slate-500"
                        )}
                      >
                        {tpl?.name ?? "No template"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {selectedProjectId && runs.length > 0 ? (
              <div className="border-t border-slate-200 px-5 pb-6 pt-4">
                <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Run history
                </h2>
                <ul className="space-y-1">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <button
                        className={clsx(
                          "block w-full rounded-lg px-3 py-1.5 text-left text-xs",
                          run.id === selectedRunId
                            ? "bg-slate-100 text-slate-900"
                            : "text-slate-600 hover:bg-slate-50"
                        )}
                        onClick={() => void handleSelectRun(run.id)}
                      >
                        <span className="truncate font-mono text-[10px] text-slate-500">{run.id}</span>
                        <span className="ml-2">{run.status}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="mx-3 mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          ) : null}
        </aside>

        {/* CENTER — chat */}
        <section className="flex h-full min-h-0 flex-col bg-white">
          <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-slate-950">
                {selectedProject?.name ?? "Select a project"}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                {activeTemplate ? (
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                    href={`/templates/${activeTemplate.id}`}
                    title="Open the template builder for this project"
                  >
                    <span>{activeTemplate.name}</span>
                    <span aria-hidden>↗</span>
                  </Link>
                ) : (
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                    href="/templates"
                  >
                    Pick a template ↗
                  </Link>
                )}
                {selectedProject ? (
                  <span className="font-mono">Root: {selectedProject.r2_root_prefix}</span>
                ) : (
                  <span>Pick a project on the left or create one.</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {activeTemplate ? (
                <Link
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  href={`/templates/${activeTemplate.id}`}
                >
                  Edit nodes
                </Link>
              ) : null}
              {selectedProject ? (
                <button
                  type="button"
                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                  onClick={() => setDeleteModalOpen(true)}
                  title="Delete this project, its files, and (optionally) the Vault items copied from it"
                >
                  Delete project
                </button>
              ) : null}
              {selectedRunSummary ? (
                <span
                  className={clsx(
                    "rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
                    statusTone(selectedRunSummary.status)
                  )}
                >
                  {selectedRunSummary.status}
                </span>
              ) : null}
            </div>
          </header>

          {!selectedProjectId ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
              Create or select a project on the left to begin.
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-6 py-6">
                {messages.length === 0 ? (
                  <div className="mx-auto max-w-2xl rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
                    <h3 className="text-base font-semibold text-slate-900">Describe the document you want.</h3>
                    <p className="mt-2 text-sm text-slate-500">
                      Type a request below and click Run. The {activeTemplate?.name ?? "active template"} will
                      execute its nodes and you'll see live progress on the right.
                    </p>
                  </div>
                ) : (
                  <div className="mx-auto flex max-w-3xl flex-col gap-4">
                    {messages.map((message) => (
                      <article
                        key={message.id}
                        className={clsx("rounded-3xl px-5 py-4 text-sm shadow-sm", {
                          "self-end max-w-[85%] bg-slate-950 text-white": message.role === "user",
                          "self-start max-w-[85%] border border-slate-200 bg-white text-slate-800":
                            message.role === "assistant",
                          "self-start max-w-[85%] border border-amber-200 bg-amber-50 text-amber-900":
                            message.role === "system",
                        })}
                      >
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] opacity-70">
                          {message.role}
                        </div>
                        <div className="whitespace-pre-wrap leading-6">{message.content}</div>
                      </article>
                    ))}
                    <div ref={chatEndRef} />
                  </div>
                )}
              </div>

              <div className="border-t border-slate-200 bg-white px-6 py-4">
                <div className="mx-auto max-w-3xl">
                  <div className="rounded-3xl border border-slate-200 bg-white shadow-sm focus-within:border-slate-400">
                    <textarea
                      className="block w-full resize-none rounded-3xl bg-transparent px-5 py-4 text-sm text-slate-900 outline-none"
                      placeholder={
                        activeTemplate
                          ? `Ask the system to run "${activeTemplate.name}". The composer is the entry point.`
                          : "Describe the document you want…"
                      }
                      rows={3}
                      value={messageInput}
                      onChange={(event) => setMessageInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composerDisabled) {
                          event.preventDefault();
                          void handleRunWorkflow();
                        }
                      }}
                    />
                    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input className="hidden" multiple ref={uploadRef} type="file" onChange={handleUpload} />
                        <button
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          onClick={() => uploadRef.current?.click()}
                          disabled={!selectedProjectId || isUploadingFiles}
                        >
                          {isUploadingFiles ? "Uploading…" : "Upload file"}
                        </button>
                        <span className="text-[11px] text-slate-400">⌘/Ctrl+Enter to run</span>
                      </div>
                      <button
                        className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 disabled:opacity-50"
                        disabled={composerDisabled}
                        onClick={handleRunWorkflow}
                      >
                        {isStartingRun ? "Starting…" : isRunInProgress ? "Run in progress…" : "Run"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {/* RIGHT INSPECTOR */}
        <aside className="flex h-full min-h-0 flex-col border-l border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              {TAB_KEYS.map((tab) => (
                <button
                  key={tab}
                  className={clsx(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                    activeTab === tab
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  )}
                  onClick={() => setActiveTab(tab)}
                >
                  {TAB_LABELS[tab]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {/* NODE FLOW */}
            {activeTab === "flow" ? (
              selectedRun && templateNodes.length > 0 ? (
                <div className="space-y-3">
                  {/* Run header: status + continue/clear-stop controls */}
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Run · {selectedRun.id}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">
                          {selectedRun.input_message}
                        </p>
                      </div>
                      <span
                        className={clsx(
                          "rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
                          statusTone(selectedRun.status)
                        )}
                      >
                        {selectedRun.status}
                      </span>
                    </div>
                    {selectedRun.status === "paused" || selectedRun.stop_after_node_id ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
                        <span className="font-semibold text-amber-900">
                          {selectedRun.status === "paused"
                            ? `Paused after ${
                                templateNodes.find((n) => n.id === selectedRun.stop_after_node_id)
                                  ?.name ?? "step"
                              }`
                            : `Will stop after ${
                                templateNodes.find((n) => n.id === selectedRun.stop_after_node_id)
                                  ?.name ?? "step"
                              }`}
                        </span>
                        <span className="ml-auto flex gap-2">
                          {selectedRun.status === "paused" ? (
                            <button
                              type="button"
                              className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                              onClick={() => void handleContinueRun()}
                            >
                              ▶ Continue
                            </button>
                          ) : null}
                          {selectedRun.stop_after_node_id ? (
                            <button
                              type="button"
                              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              onClick={() => void handleClearStopPoint()}
                            >
                              Clear stop
                            </button>
                          ) : null}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  {/* Vertical stack of nodes */}
                  {templateNodes.map((tplNode, index) => {
                    const exec = nodeExecutions.get(tplNode.id);
                    const status = exec?.status ?? "waiting";
                    const isStopPoint = selectedRun.stop_after_node_id === tplNode.id;
                    const isPausedHere =
                      selectedRun.status === "paused" && isStopPoint;
                    const isSelected = tplNode.id === selectedNodeId;
                    // Match by node_id within this run — paths are now run-scoped
                    // (runs/<run_id>/<configured-path>) so direct path equality with
                    // the template's logical path no longer works.
                    const artifact =
                      selectedRun.artifacts?.find(
                        (a) =>
                          a.deleted_at === null &&
                          a.run_id === selectedRun.id &&
                          a.node_id === tplNode.id
                      ) ?? null;
                    const nextNode = templateNodes[index + 1];
                    const modelDisplay =
                      exec?.model_used ??
                      tplNode.model ??
                      tplNode.model_profile ??
                      (tplNode.type === "pdf_generator" ? "no model" : "—");
                    return (
                      <div key={tplNode.id}>
                        {/* Node card */}
                        <button
                          type="button"
                          className={clsx(
                            "block w-full rounded-xl border p-3 text-left transition",
                            isSelected
                              ? "border-slate-900 bg-white shadow-md"
                              : "border-slate-200 bg-white hover:border-slate-300",
                            isPausedHere && "ring-2 ring-amber-400",
                            isStopPoint && !isPausedHere && "ring-1 ring-amber-300"
                          )}
                          onClick={() => setSelectedNodeId(tplNode.id)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                Step {index + 1} · {tplNode.type}
                              </p>
                              <h3 className="mt-0.5 text-sm font-semibold text-slate-900">
                                {tplNode.name}
                              </h3>
                            </div>
                            <span
                              className={clsx(
                                "shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]",
                                statusTone(status)
                              )}
                            >
                              {status}
                            </span>
                          </div>
                          <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                            <div>
                              <dt className="text-slate-500">Model</dt>
                              <dd className="mt-0.5 break-words text-slate-700">{modelDisplay}</dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">Tokens / Cost</dt>
                              <dd className="mt-0.5 text-slate-700">
                                {(exec?.token_input ?? 0) + (exec?.token_output ?? 0)} ·{" "}
                                {exec?.cost_estimate != null
                                  ? `$${exec.cost_estimate.toFixed(4)}`
                                  : "—"}
                              </dd>
                            </div>
                            {tplNode.reads?.length ? (
                              <div className="col-span-2">
                                <dt className="text-slate-500">Reads</dt>
                                <dd className="mt-0.5 break-all font-mono text-[10px] text-slate-700">
                                  {tplNode.reads.join(", ")}
                                </dd>
                              </div>
                            ) : null}
                          </dl>
                          {exec?.error_message ? (
                            <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                              {exec.error_message}
                            </div>
                          ) : null}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span
                              role="button"
                              tabIndex={0}
                              className={clsx(
                                "cursor-pointer rounded-md px-2 py-0.5 text-[10px] font-semibold transition",
                                isStopPoint
                                  ? "bg-amber-500 text-white hover:bg-amber-600"
                                  : "border border-slate-200 bg-white text-slate-600 hover:bg-amber-50 hover:text-amber-800"
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (isStopPoint) void handleClearStopPoint();
                                else void handleSetStopPoint(tplNode.id);
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                event.stopPropagation();
                                if (isStopPoint) void handleClearStopPoint();
                                else void handleSetStopPoint(tplNode.id);
                              }}
                            >
                              {isStopPoint ? "■ Stops here" : "⏸ Stop after"}
                            </span>
                          </div>
                        </button>

                        {/* File arrow between this node and the next */}
                        {nextNode ? (
                          <div className="my-1 ml-4 flex items-center gap-2 border-l-2 border-dashed border-slate-200 pl-3 py-2 text-[11px]">
                            <span className="text-slate-400">↓</span>
                            <span
                              className={clsx(
                                "rounded-md px-2 py-0.5 font-mono",
                                artifact
                                  ? "bg-emerald-50 text-emerald-800"
                                  : "bg-slate-100 text-slate-500"
                              )}
                            >
                              {tplNode.output.path}
                            </span>
                            {artifact ? (
                              <span className="flex gap-1">
                                <button
                                  type="button"
                                  className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50"
                                  onClick={() =>
                                    window.open(
                                      filePreviewPath(artifact.id),
                                      "_blank",
                                      "noopener,noreferrer"
                                    )
                                  }
                                >
                                  view
                                </button>
                                <button
                                  type="button"
                                  className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50"
                                  onClick={() => void handleDownload(artifact)}
                                >
                                  download
                                </button>
                              </span>
                            ) : (
                              <span className="text-slate-400">pending</span>
                            )}
                          </div>
                        ) : artifact ? (
                          <div className="my-1 ml-4 flex items-center gap-2 border-l-2 border-emerald-300 pl-3 py-2 text-[11px]">
                            <span className="font-semibold text-emerald-700">final →</span>
                            <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-emerald-800">
                              {tplNode.output.path}
                            </span>
                            <button
                              type="button"
                              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50"
                              onClick={() =>
                                window.open(
                                  filePreviewPath(artifact.id),
                                  "_blank",
                                  "noopener,noreferrer"
                                )
                              }
                            >
                              view
                            </button>
                            <button
                              type="button"
                              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50"
                              onClick={() => void handleDownload(artifact)}
                            >
                              download
                            </button>
                            <button
                              type="button"
                              className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-100"
                              onClick={() => void handleSaveToVault(artifact)}
                            >
                              Save to Vault
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {/* Selected node JSON inspector */}
                  <details className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                    <summary className="cursor-pointer font-semibold text-slate-700">
                      Selected node — JSON inspector
                    </summary>
                    <div className="mt-3 space-y-2">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Input JSON
                        </p>
                        <div className="mt-1 max-h-[200px] overflow-auto rounded-lg bg-slate-50 p-2">
                          <JsonView collapsed={1} src={selectedNode?.input_json ?? {}} />
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Output JSON
                        </p>
                        <div className="mt-1 max-h-[220px] overflow-auto rounded-lg bg-slate-50 p-2">
                          <JsonView collapsed={1} src={selectedNode?.output_json ?? {}} />
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 text-center text-sm text-slate-500">
                  {selectedProject
                    ? "No run yet. Type a document request and click Run."
                    : "Select or create a project to begin."}
                </div>
              )
            ) : null}

            {/* DATA INSPECTOR */}
            {activeTab === "data" ? (
              selectedRun ? (
                <div className="overflow-auto rounded-2xl border border-slate-200 bg-white p-4">
                  <JsonView collapsed={2} src={selectedRun.state_json ?? {}} />
                </div>
              ) : (
                <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
                  Select a run to inspect its state_json.
                </div>
              )
            ) : null}

            {/* FILES */}
            {activeTab === "files" ? (
              <div className="space-y-5">
                {(["input", "working", "final", "logs", "archive"] as const).map((group) => (
                  <section key={group}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                        {group}
                      </h3>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        {filesByGroup[group].length}
                      </span>
                    </div>
                    {filesByGroup[group].length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                        Empty.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {filesByGroup[group].map((artifact) => (
                          <div
                            key={`${artifact.id}-${artifact.path}`}
                            className="rounded-xl border border-slate-200 bg-white p-3"
                          >
                            <div className="flex flex-col gap-2">
                              <div>
                                <p className="truncate text-sm font-semibold text-slate-900">
                                  {artifact.filename}
                                </p>
                                <p className="mt-0.5 break-all text-[10px] text-slate-500">
                                  {artifact.path}
                                </p>
                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                                  <span>{artifact.mime_type}</span>
                                  <span>{formatBytes(artifact.size_bytes)}</span>
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <button
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                                  onClick={() =>
                                    loadArtifactPreview(artifact).catch((err) =>
                                      setPreviewError(
                                        err instanceof Error ? err.message : "Preview failed."
                                      )
                                    )
                                  }
                                >
                                  Preview
                                </button>
                                <button
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                                  onClick={() => void handleDownload(artifact)}
                                >
                                  Download
                                </button>
                                <button
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                                  onClick={() =>
                                    navigator.clipboard
                                      .writeText(artifact.path)
                                      .catch(() => undefined)
                                  }
                                >
                                  Copy path
                                </button>
                                <button
                                  className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-100"
                                  onClick={() => void handleSaveToVault(artifact)}
                                  title="Copy this file into your permanent Vault"
                                >
                                  Save to Vault
                                </button>
                                <button
                                  className="rounded-md border border-red-200 px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-50"
                                  onClick={() => void handleDelete(artifact)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
                {previewArtifactId && previewUrl ? (
                  <section>
                    <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Preview
                    </h3>
                    {previewIsPdf ? (
                      <iframe
                        className="h-[420px] w-full rounded-xl border border-slate-200 bg-white"
                        src={previewUrl}
                      />
                    ) : (
                      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-700">
                        {previewText}
                      </pre>
                    )}
                  </section>
                ) : null}
              </div>
            ) : null}

            {/* OUTPUT VIEWER */}
            {activeTab === "output" ? (
              selectedRun ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {allowedViewers.map((viewer) => (
                      <button
                        key={viewer}
                        className={clsx(
                          "rounded-lg px-3 py-1.5 text-xs font-semibold",
                          outputViewer === viewer
                            ? "bg-slate-900 text-white"
                            : "border border-slate-200 bg-white text-slate-700"
                        )}
                        onClick={() => setOutputViewer(viewer)}
                      >
                        {VIEWER_LABELS[viewer]}
                      </button>
                    ))}
                  </div>
                  <div className="overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
                    {previewError ? (
                      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        {previewError}
                      </p>
                    ) : null}
                    {outputViewer === "markdown" ? (
                      latestMarkdownArtifact ? (
                        <article className="prose prose-slate max-w-none prose-headings:text-slate-950">
                          <ReactMarkdown>
                            {previewArtifactId === latestMarkdownArtifact.id ? previewText : ""}
                          </ReactMarkdown>
                        </article>
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                          {selectedRunActive
                            ? "Output will appear when final files are created."
                            : "No final markdown for this run."}
                        </div>
                      )
                    ) : outputViewer === "pdf" ? (
                      latestPdfArtifact ? (
                        <iframe
                          className="h-[560px] w-full rounded-xl border border-slate-200 bg-white"
                          src={
                            previewArtifactId === latestPdfArtifact.id
                              ? previewUrl
                              : filePreviewPath(latestPdfArtifact.id)
                          }
                        />
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                          {selectedRunActive ? "PDF will appear when generated." : "No final PDF for this run."}
                        </div>
                      )
                    ) : outputViewer === "json" ? (
                      <div className="overflow-auto">
                        <JsonView collapsed={2} src={selectedRun.state_json ?? {}} />
                      </div>
                    ) : (
                      <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
                        {previewText}
                      </pre>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 text-center text-sm text-slate-500">
                  No run selected.
                </div>
              )
            ) : null}

            {/* LOGS */}
            {activeTab === "logs" ? (
              <div className="space-y-4">
                {selectedRun ? (
                  <>
                    <section className="rounded-2xl border border-slate-200 bg-white p-4">
                      <h3 className="text-sm font-semibold text-slate-900">Run summary</h3>
                      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-700">
                        <div>
                          <dt className="text-slate-500">Status</dt>
                          <dd>{selectedRun.status}</dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Created</dt>
                          <dd>{formatDateTime(selectedRun.created_at)}</dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Updated</dt>
                          <dd>{formatDateTime(selectedRun.updated_at)}</dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Completed</dt>
                          <dd>{formatDateTime(selectedRun.completed_at)}</dd>
                        </div>
                      </dl>
                      {selectedRun.error_message ? (
                        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {selectedRun.error_message}
                        </div>
                      ) : null}
                    </section>

                    <section>
                      <h3 className="mb-2 text-sm font-semibold text-slate-900">Run events</h3>
                      {(selectedRun.events ?? []).length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                          No events yet.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {selectedRun.events.map((event) => (
                            <article key={event.id} className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-semibold text-slate-900">{event.type}</p>
                                <span className="text-[10px] text-slate-500">
                                  {formatDateTime(event.created_at)}
                                </span>
                              </div>
                              <pre className="mt-2 max-h-[140px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-[10px] leading-4 text-slate-700">
                                {JSON.stringify(event.event_json, null, 2)}
                              </pre>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>

                    <section>
                      <h3 className="mb-2 text-sm font-semibold text-slate-900">Node executions</h3>
                      {(selectedRun.node_executions ?? []).length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                          None.
                        </div>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-200">
                          <table className="min-w-full text-left text-xs">
                            <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                              <tr>
                                <th className="px-3 py-2">Node</th>
                                <th className="px-3 py-2">Status</th>
                                <th className="px-3 py-2">Model</th>
                                <th className="px-3 py-2">In</th>
                                <th className="px-3 py-2">Out</th>
                                <th className="px-3 py-2">$</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedRun.node_executions.map((node: NodeExecution) => (
                                <tr key={node.id} className="border-t border-slate-200 text-slate-700">
                                  <td className="px-3 py-2 font-medium text-slate-900">{node.node_name}</td>
                                  <td className="px-3 py-2">{node.status}</td>
                                  <td className="px-3 py-2 break-words">
                                    {node.model_used ?? node.model_profile ?? "—"}
                                  </td>
                                  <td className="px-3 py-2">{node.token_input ?? 0}</td>
                                  <td className="px-3 py-2">{node.token_output ?? 0}</td>
                                  <td className="px-3 py-2">
                                    {node.cost_estimate != null ? `$${node.cost_estimate.toFixed(4)}` : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </>
                ) : (
                  <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
                    Select a run to see logs.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <FileExplorerDrawer
        open={explorerOpen}
        onClose={() => setExplorerOpen(false)}
        initialTab={explorerInitialTab}
        project={selectedProject}
        onProjectFilesChanged={() => {
          if (selectedProjectId) {
            void loadProjectData(selectedProjectId, selectedRunId || undefined);
          }
        }}
      />

      <DeleteProjectModal
        open={deleteModalOpen}
        project={selectedProject}
        onClose={() => setDeleteModalOpen(false)}
        onDeleted={(deletedId) => {
          setProjects((current) => current.filter((p) => p.id !== deletedId));
          if (selectedProjectId === deletedId) {
            setSelectedProjectId("");
            setSelectedRunId("");
            setSelectedRun(null);
            setMessages([]);
            setFiles([]);
            setRuns([]);
          }
        }}
      />
    </main>
  );
}

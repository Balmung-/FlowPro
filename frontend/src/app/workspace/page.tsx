"use client";

import "react18-json-view/src/style.css";

import clsx from "clsx";
import JsonView from "react18-json-view";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import DeleteProjectModal from "@/components/delete-project-modal";
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
  User,
  apiFetch,
} from "@/lib/api";
import { clearAuthSession, getStoredToken } from "@/lib/auth";

const TAB_KEYS = ["flow", "data", "files", "output", "logs"] as const;
type TabKey = (typeof TAB_KEYS)[number];
type ArtifactGroupKey = "working" | "final" | "logs" | "archive";
type OutputViewer = "markdown" | "pdf";

type ProjectCreatePayload = {
  name: string;
  description: string;
  template_id?: string | null;
};

const TAB_LABELS: Record<TabKey, string> = {
  flow: "Node Flow",
  data: "Data Inspector",
  files: "Files",
  output: "Output Viewer",
  logs: "Logs",
};

const RUN_EVENT_TYPES = [
  "run.started",
  "node.started",
  "node.completed",
  "node.failed",
  "artifact.created",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.paused",
] as const;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusTone(status: string): string {
  switch (status) {
    case "running":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "failed":
      return "border-red-200 bg-red-50 text-red-800";
    case "queued":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "paused":
      return "border-purple-200 bg-purple-50 text-purple-800";
    case "skipped":
      return "border-slate-300 bg-slate-100 text-slate-700";
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function filePreviewPath(artifactId: string): string {
  return `${API_BASE}/artifacts/${artifactId}/content`;
}

function toRunSummary(run: Run | RunDetail): Run {
  return {
    id: run.id,
    project_id: run.project_id,
    status: run.status,
    input_message: run.input_message,
    state_json: run.state_json,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
    error_message: run.error_message,
    stop_after_node_id: run.stop_after_node_id,
  };
}

function buildRunLabel(run: Run): string {
  return `${formatDateTime(run.created_at)} - ${run.status}`;
}

function buildArtifactGroups(artifacts: Artifact[]): Record<ArtifactGroupKey, Artifact[]> {
  const groups: Record<ArtifactGroupKey, Artifact[]> = {
    working: [],
    final: [],
    logs: [],
    archive: [],
  };
  for (const artifact of artifacts) {
    const group = artifact.path.split("/")[0] as ArtifactGroupKey;
    if (group in groups) {
      groups[group].push(artifact);
    }
  }
  return groups;
}

export default function WorkspacePage() {
  const router = useRouter();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  const [me, setMe] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>("flow");
  const [outputViewer, setOutputViewer] = useState<OutputViewer>("markdown");
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectTemplateId, setProjectTemplateId] = useState("");
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [previewArtifactId, setPreviewArtifactId] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewIsPdf, setPreviewIsPdf] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedProject?.template_id) ?? null,
    [selectedProject, templates]
  );

  const selectedRunSummary = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? selectedRun ?? null,
    [runs, selectedRun, selectedRunId]
  );

  const isRunInProgress = useMemo(
    () => runs.some((run) => run.status === "queued" || run.status === "running"),
    [runs]
  );

  const activeRunArtifacts = useMemo(
    () => (selectedRun?.artifacts ?? []).filter((artifact) => artifact.deleted_at === null),
    [selectedRun]
  );

  const artifactGroups = useMemo(() => buildArtifactGroups(activeRunArtifacts), [activeRunArtifacts]);

  const projectInputFiles = useMemo(
    () =>
      files.filter(
        (artifact) => artifact.deleted_at === null && artifact.path.startsWith("input/")
      ),
    [files]
  );

  const latestMarkdownArtifact = useMemo(
    () => activeRunArtifacts.find((artifact) => artifact.path === "final/output.md") ?? null,
    [activeRunArtifacts]
  );

  const latestPdfArtifact = useMemo(
    () => activeRunArtifacts.find((artifact) => artifact.path === "final/output.pdf") ?? null,
    [activeRunArtifacts]
  );

  const selectedRunActive =
    selectedRunSummary?.status === "queued" || selectedRunSummary?.status === "running";

  const pipelineNodes = useMemo(() => selectedRun?.node_executions ?? [], [selectedRun]);

  const selectedNode = useMemo(
    () => pipelineNodes.find((node) => node.node_id === selectedNodeId) ?? null,
    [pipelineNodes, selectedNodeId]
  );

  const selectedNodeArtifact = useMemo(
    () =>
      activeRunArtifacts.find(
        (artifact) => artifact.node_id === selectedNodeId && artifact.run_id === selectedRun?.id
      ) ?? null,
    [activeRunArtifacts, selectedNodeId, selectedRun]
  );

  const canStartRun = Boolean(
    selectedProjectId && messageInput.trim() && !isStartingRun && !isRunInProgress
  );

  const resetPreview = useCallback(() => {
    setPreviewArtifactId("");
    setPreviewText("");
    setPreviewUrl("");
    setPreviewIsPdf(false);
    setPreviewError(null);
  }, []);

  const loadProjects = useCallback(async () => {
    const projectList = await apiFetch<Project[]>("/projects");
    setProjects(projectList);
    setSelectedProjectId((current) => {
      if (current && projectList.some((project) => project.id === current)) return current;
      return projectList[0]?.id ?? "";
    });
  }, []);

  const loadTemplates = useCallback(async () => {
    const templateList = await apiFetch<Template[]>("/templates");
    setTemplates(templateList);
    setProjectTemplateId((current) => current || templateList[0]?.id || "");
  }, []);

  const loadRunDetail = useCallback(async (runId: string) => {
    if (!runId) {
      setSelectedRun(null);
      return null;
    }
    const detail = await apiFetch<RunDetail>(`/runs/${runId}`);
    setSelectedRun(detail);
    setRuns((current) => {
      const summary = toRunSummary(detail);
      return current.some((run) => run.id === summary.id)
        ? current.map((run) => (run.id === summary.id ? summary : run))
        : [summary, ...current];
    });
    return detail;
  }, []);

  const refreshRunsList = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const runList = await apiFetch<Run[]>(`/projects/${projectId}/runs`);
    setRuns(runList);
  }, []);

  const refreshProjectFiles = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const projectFiles = await apiFetch<Artifact[]>(`/projects/${projectId}/files`);
    setFiles(projectFiles);
  }, []);

  const refreshRunMessages = useCallback(async (projectId: string, runId: string) => {
    if (!projectId || !runId) {
      setMessages([]);
      return;
    }
    const runMessages = await apiFetch<ChatMessage[]>(
      `/projects/${projectId}/messages?run_id=${encodeURIComponent(runId)}`
    );
    setMessages(runMessages);
  }, []);

  const loadProjectData = useCallback(
    async (projectId: string, preferredRunId?: string) => {
      if (!projectId) {
        setFiles([]);
        setRuns([]);
        setMessages([]);
        setSelectedRunId("");
        setSelectedRun(null);
        resetPreview();
        return;
      }

      setIsLoadingWorkspace(true);
      try {
        const [projectFiles, projectRuns] = await Promise.all([
          apiFetch<Artifact[]>(`/projects/${projectId}/files`),
          apiFetch<Run[]>(`/projects/${projectId}/runs`),
        ]);
        setFiles(projectFiles);
        setRuns(projectRuns);

        const nextRunId =
          preferredRunId && projectRuns.some((run) => run.id === preferredRunId)
            ? preferredRunId
            : selectedRunId && projectRuns.some((run) => run.id === selectedRunId)
              ? selectedRunId
              : projectRuns[0]?.id ?? "";

        setSelectedRunId(nextRunId);
        resetPreview();

        if (nextRunId) {
          await Promise.all([loadRunDetail(nextRunId), refreshRunMessages(projectId, nextRunId)]);
        } else {
          setSelectedRun(null);
          setMessages([]);
        }
      } finally {
        setIsLoadingWorkspace(false);
      }
    },
    [loadRunDetail, refreshRunMessages, resetPreview, selectedRunId]
  );

  const loadArtifactPreview = useCallback(async (artifact: Artifact) => {
    setPreviewError(null);
    setPreviewArtifactId(artifact.id);
    setPreviewUrl(filePreviewPath(artifact.id));
    const isPdf = artifact.mime_type.includes("pdf");
    setPreviewIsPdf(isPdf);
    if (isPdf) {
      setPreviewText("");
      return;
    }
    const response = await fetch(filePreviewPath(artifact.id), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Preview failed for ${artifact.filename}`);
    }
    setPreviewText(await response.text());
  }, []);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      router.replace("/login");
      return;
    }

    loadProjects().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load projects.");
    });
    loadTemplates().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load templates.");
    });
    apiFetch<User>("/auth/me")
      .then(setMe)
      .catch(() => undefined);

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      seenEventIdsRef.current.clear();
    };
  }, [loadProjects, loadTemplates, router]);

  useEffect(() => {
    if (!selectedProjectId) {
      setFiles([]);
      setRuns([]);
      setMessages([]);
      setSelectedRunId("");
      setSelectedRun(null);
      resetPreview();
      return;
    }
    loadProjectData(selectedProjectId).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load project workspace.");
    });
  }, [loadProjectData, resetPreview, selectedProjectId]);

  useEffect(() => {
    if (pipelineNodes.length === 0) {
      setSelectedNodeId("");
      return;
    }
    if (!pipelineNodes.some((node) => node.node_id === selectedNodeId)) {
      setSelectedNodeId(pipelineNodes[0].node_id);
    }
  }, [pipelineNodes, selectedNodeId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

    const terminalEvents = new Set(["run.completed", "run.failed", "run.cancelled"]);

    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as RunEvent;
        if (seenEventIdsRef.current.has(payload.id)) return;
        seenEventIdsRef.current.add(payload.id);

        setSelectedRun((current) => {
          if (!current || current.id !== selectedRunId) return current;
          if (current.events.some((item) => item.id === payload.id)) return current;
          return { ...current, events: [...current.events, payload] };
        });

        loadRunDetail(selectedRunId).catch(() => undefined);

        if (payload.type === "artifact.created" || payload.type === "node.completed") {
          refreshProjectFiles(selectedProjectId).catch(() => undefined);
        }

        if (payload.type === "run.completed" || payload.type === "run.failed" || payload.type === "run.paused") {
          refreshRunsList(selectedProjectId).catch(() => undefined);
          refreshRunMessages(selectedProjectId, selectedRunId).catch(() => undefined);
          refreshProjectFiles(selectedProjectId).catch(() => undefined);
        }

        if (terminalEvents.has(payload.type)) {
          source.close();
          if (eventSourceRef.current === source) {
            eventSourceRef.current = null;
          }
        }
      } catch (streamError) {
        setError(
          streamError instanceof Error
            ? streamError.message
            : "Failed to process live run event."
        );
      }
    };

    for (const eventType of RUN_EVENT_TYPES) {
      source.addEventListener(eventType, handleEvent as EventListener);
    }

    return () => {
      source.close();
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
    };
  }, [loadRunDetail, refreshProjectFiles, refreshRunMessages, refreshRunsList, selectedProjectId, selectedRunId]);

  useEffect(() => {
    const artifact = outputViewer === "markdown" ? latestMarkdownArtifact : latestPdfArtifact;
    if (!artifact) {
      if (activeTab === "output") {
        resetPreview();
      }
      return;
    }
    if (activeTab !== "output") return;
    loadArtifactPreview(artifact).catch((err) => {
      setPreviewError(err instanceof Error ? err.message : "Output preview failed.");
    });
  }, [activeTab, latestMarkdownArtifact, latestPdfArtifact, loadArtifactPreview, outputViewer, resetPreview]);

  async function handleSelectRun(runId: string) {
    setSelectedRunId(runId);
    resetPreview();
    if (!selectedProjectId || !runId) {
      setSelectedRun(null);
      setMessages([]);
      return;
    }
    try {
      await Promise.all([loadRunDetail(runId), refreshRunMessages(selectedProjectId, runId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run.");
    }
  }

  async function handleCreateProject() {
    const name = projectName.trim();
    if (!name) {
      setError("Project name is required.");
      return;
    }
    setIsCreatingProject(true);
    setError(null);
    try {
      const payload: ProjectCreatePayload = {
        name,
        description: projectDescription.trim(),
      };
      if (projectTemplateId) payload.template_id = projectTemplateId;
      const project = await apiFetch<Project>("/projects", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setSelectedProjectId(project.id);
      setSelectedRunId("");
      setSelectedRun(null);
      setMessages([]);
      setFiles([]);
      setRuns([]);
      setProjectName("");
      setProjectDescription("");
      setShowCreateProject(false);
      setActiveTab("flow");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project.");
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function handleStartRun() {
    if (!selectedProjectId) {
      setError("Select a project first.");
      return;
    }
    const inputMessage = messageInput.trim();
    if (!inputMessage) {
      setError("Type a document request first.");
      return;
    }
    setIsStartingRun(true);
    setError(null);
    try {
      const run = await apiFetch<Run>(`/projects/${selectedProjectId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input_message: inputMessage }),
      });
      setMessageInput("");
      setSelectedRunId(run.id);
      setRuns((current) => [toRunSummary(run), ...current.filter((item) => item.id !== run.id)]);
      setActiveTab("flow");
      resetPreview();
      await Promise.all([
        loadRunDetail(run.id),
        refreshRunMessages(selectedProjectId, run.id),
        refreshRunsList(selectedProjectId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run.");
    } finally {
      setIsStartingRun(false);
    }
  }

  async function handleContinueRun() {
    if (!selectedRunId || !selectedProjectId) return;
    setError(null);
    try {
      await apiFetch<Run>(`/runs/${selectedRunId}/continue`, { method: "POST" });
      await Promise.all([
        loadRunDetail(selectedRunId),
        refreshRunsList(selectedProjectId),
        refreshRunMessages(selectedProjectId, selectedRunId),
      ]);
      setActiveTab("flow");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to continue run.");
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = event.target.files;
    if (!selectedProjectId || !selectedFiles?.length) return;

    setIsUploadingFiles(true);
    setError(null);
    try {
      for (const file of Array.from(selectedFiles)) {
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
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
          body: file,
        });
        if (!uploadResponse.ok) {
          throw new Error(`Upload failed for ${file.name}.`);
        }

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
      await refreshProjectFiles(selectedProjectId);
      setActiveTab("files");
    } catch (err) {
      setError(err instanceof Error ? err.message : "File upload failed.");
    } finally {
      setIsUploadingFiles(false);
      if (event.target) {
        event.target.value = "";
      }
    }
  }

  async function handleDownload(artifact: Artifact) {
    try {
      const { download_url } = await apiFetch<{ download_url: string }>(
        `/artifacts/${artifact.id}/download-url`
      );
      window.open(download_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    }
  }

  async function handleDelete(artifact: Artifact) {
    if (!selectedProjectId) return;
    if (!window.confirm(`Delete ${artifact.filename}?`)) return;

    setError(null);
    try {
      await apiFetch(`/artifacts/${artifact.id}`, { method: "DELETE" });
      if (previewArtifactId === artifact.id) {
        resetPreview();
      }
      await refreshProjectFiles(selectedProjectId);
      if (selectedRunId) {
        await loadRunDetail(selectedRunId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  function handleLogout() {
    clearAuthSession();
    router.replace("/login");
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="flex w-[360px] min-w-[320px] flex-col border-r border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  FlowPro
                </div>
                <h1 className="mt-2 text-2xl font-semibold text-slate-950">Document Cockpit</h1>
                <p className="mt-1 text-sm text-slate-500">
                  Project chat, runs, files, and outputs in one workspace.
                </p>
              </div>
              <button
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              <Link
                className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                href="/workspace"
              >
                Workspace
              </Link>
              <Link
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                href="/templates"
              >
                Templates
              </Link>
            </div>
          </div>

          <div className="border-b border-slate-200 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Project
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {selectedProject ? selectedProject.name : "Select or create a project."}
                </p>
              </div>
              <button
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setShowCreateProject((current) => !current)}
              >
                {showCreateProject ? "Close" : "New project"}
              </button>
            </div>

            <select
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>

            {showCreateProject ? (
              <div className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                  placeholder="Project name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
                <textarea
                  className="h-20 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                  placeholder="Optional description"
                  value={projectDescription}
                  onChange={(event) => setProjectDescription(event.target.value)}
                />
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                  value={projectTemplateId}
                  onChange={(event) => setProjectTemplateId(event.target.value)}
                >
                  <option value="">Default workflow</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
                <button
                  className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                  disabled={isCreatingProject || !projectName.trim()}
                  onClick={() => void handleCreateProject()}
                >
                  {isCreatingProject ? "Creating project..." : "Create project"}
                </button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Chat history
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {selectedRun
                    ? `Run ${selectedRun.id} - ${selectedRun.status}`
                    : selectedProject
                      ? "No run yet. Type a request below and click Run."
                      : "Choose a project to begin."}
                </p>
              </div>
              {selectedProject && runs.length > 0 ? (
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">
                  {runs.length} run{runs.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            {!selectedProject ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                Select a project or create one to start the document workflow.
              </div>
            ) : !selectedRun ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                No run yet. Type a document request and click Run.
              </div>
            ) : messages.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                Loading chat for this run.
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  const isSystem = message.role === "system";
                  return (
                    <article
                      key={message.id}
                      className={clsx(
                        "rounded-2xl border px-4 py-3 shadow-sm",
                        isUser
                          ? "ml-6 border-slate-900 bg-slate-900 text-white"
                          : isSystem
                            ? "mr-6 border-amber-200 bg-amber-50 text-amber-900"
                            : "mr-6 border-slate-200 bg-white text-slate-900"
                      )}
                    >
                      <div className="flex items-center justify-between gap-3 text-[11px]">
                        <span
                          className={clsx(
                            "font-semibold uppercase tracking-[0.16em]",
                            isUser ? "text-slate-200" : "text-slate-500"
                          )}
                        >
                          {message.role}
                        </span>
                        <span className={clsx(isUser ? "text-slate-300" : "text-slate-500")}>
                          {formatDateTime(message.created_at)}
                        </span>
                      </div>
                      <p
                        className={clsx(
                          "mt-2 whitespace-pre-wrap text-sm leading-6",
                          isUser ? "text-white" : "text-inherit"
                        )}
                      >
                        {message.content}
                      </p>
                    </article>
                  );
                })}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 px-5 py-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <textarea
                className="h-32 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none"
                placeholder="Create a short proposal for an AI document cockpit."
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <input
                    ref={uploadRef}
                    className="hidden"
                    multiple
                    type="file"
                    onChange={handleUpload}
                  />
                  <button
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!selectedProjectId || isUploadingFiles}
                    onClick={() => uploadRef.current?.click()}
                  >
                    {isUploadingFiles ? "Uploading..." : "Upload file"}
                  </button>
                  <span className="text-xs text-slate-500">
                    {projectInputFiles.length} input file{projectInputFiles.length === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                  disabled={!canStartRun}
                  onClick={() => void handleStartRun()}
                >
                  {isStartingRun ? "Starting..." : isRunInProgress ? "Run in progress" : "Run workflow"}
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                The selected project will use its assigned workflow and create Markdown plus PDF outputs.
              </p>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-slate-200 bg-white px-6 py-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-700">
                    {selectedProject ? selectedProject.name : "No project selected"}
                  </span>
                  {selectedTemplate ? <span>Workflow: {selectedTemplate.name}</span> : null}
                  {me?.mock_ai_enabled ? (
                    <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 font-semibold text-blue-700">
                      MOCK_AI enabled
                    </span>
                  ) : null}
                </div>
                <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                  {selectedProject ? selectedProject.name : "Document workspace"}
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-slate-500">
                  {selectedProject
                    ? selectedProject.description || "Run the fixed document workflow and inspect every step live."
                    : "Create or select a project, then type a request in the composer and run the workflow."}
                </p>
              </div>

              <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 xl:min-w-[360px]">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Selected run
                    </label>
                    <select
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                      disabled={!selectedProjectId || runs.length === 0}
                      value={selectedRunId}
                      onChange={(event) => void handleSelectRun(event.target.value)}
                    >
                      <option value="">No run selected</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {buildRunLabel(run)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <span
                      className={clsx(
                        "inline-flex rounded-full border px-3 py-2 text-xs font-semibold",
                        statusTone(selectedRunSummary?.status ?? "idle")
                      )}
                    >
                      {selectedRunSummary?.status ?? "idle"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                    disabled={!canStartRun}
                    onClick={() => void handleStartRun()}
                  >
                    {isStartingRun ? "Starting..." : "Run current message"}
                  </button>
                  {selectedRunSummary?.status === "paused" ? (
                    <button
                      className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      onClick={() => void handleContinueRun()}
                    >
                      Continue run
                    </button>
                  ) : null}
                  {selectedProject ? (
                    <button
                      className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                      onClick={() => setDeleteModalOpen(true)}
                    >
                      Delete project
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {error ? (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}
          </header>

          <div className="border-b border-slate-200 bg-white px-6">
            <div className="flex flex-wrap gap-2 py-4">
              {TAB_KEYS.map((tab) => (
                <button
                  key={tab}
                  className={clsx(
                    "rounded-xl px-4 py-2 text-sm font-semibold transition",
                    activeTab === tab
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  )}
                  onClick={() => setActiveTab(tab)}
                >
                  {TAB_LABELS[tab]}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {!selectedProject ? (
              <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-8 text-center">
                <div>
                  <h3 className="text-xl font-semibold text-slate-950">No project selected</h3>
                  <p className="mt-2 max-w-xl text-sm text-slate-500">
                    Select a project from the sidebar or create a new one. Then type a document request and click Run.
                  </p>
                </div>
              </div>
            ) : isLoadingWorkspace ? (
              <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-slate-200 bg-white px-8 text-center text-sm text-slate-500">
                Loading workspace...
              </div>
            ) : activeTab === "flow" ? (
              !selectedRun ? (
                <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-8 text-center">
                  <div>
                    <h3 className="text-xl font-semibold text-slate-950">No run yet</h3>
                    <p className="mt-2 max-w-xl text-sm text-slate-500">
                      Type a document request in the composer and click Run. The workflow steps will appear here once a run exists.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                      <h3 className="text-base font-semibold text-slate-950">Pipeline</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        Seven workflow steps for the selected run. Click a step for details.
                      </p>
                    </div>
                    {pipelineNodes.map((node, index) => {
                      const artifact = activeRunArtifacts.find((item) => item.node_id === node.node_id) ?? null;
                      const isSelected = selectedNodeId === node.node_id;
                      return (
                        <div key={node.id} className="relative pl-6">
                          {index < pipelineNodes.length - 1 ? (
                            <span className="absolute left-[14px] top-14 h-[calc(100%+12px)] w-px bg-slate-200" />
                          ) : null}
                          <span className="absolute left-[6px] top-7 h-4 w-4 rounded-full border-2 border-slate-200 bg-white" />
                          <button
                            className={clsx(
                              "w-full rounded-2xl border p-4 text-left shadow-sm transition",
                              isSelected
                                ? "border-slate-900 bg-slate-900 text-white"
                                : "border-slate-200 bg-white hover:border-slate-300"
                            )}
                            onClick={() => setSelectedNodeId(node.node_id)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p
                                  className={clsx(
                                    "text-xs font-semibold uppercase tracking-[0.18em]",
                                    isSelected ? "text-slate-300" : "text-slate-500"
                                  )}
                                >
                                  Step {index + 1}
                                </p>
                                <h4
                                  className={clsx(
                                    "mt-1 text-base font-semibold",
                                    isSelected ? "text-white" : "text-slate-950"
                                  )}
                                >
                                  {node.node_name}
                                </h4>
                              </div>
                              <span
                                className={clsx(
                                  "rounded-full border px-2 py-1 text-[11px] font-semibold",
                                  statusTone(node.status),
                                  isSelected && "border-white/20 bg-white/10 text-white"
                                )}
                              >
                                {node.status}
                              </span>
                            </div>
                            <dl
                              className={clsx(
                                "mt-4 grid grid-cols-2 gap-3 text-xs",
                                isSelected ? "text-slate-200" : "text-slate-600"
                              )}
                            >
                              <div>
                                <dt className={clsx("font-semibold", isSelected ? "text-slate-300" : "text-slate-500")}>Model</dt>
                                <dd className="mt-1 break-words">{node.model_used ?? node.model_profile ?? "-"}</dd>
                              </div>
                              <div>
                                <dt className={clsx("font-semibold", isSelected ? "text-slate-300" : "text-slate-500")}>Tokens</dt>
                                <dd className="mt-1">{(node.token_input ?? 0) + (node.token_output ?? 0)}</dd>
                              </div>
                              <div>
                                <dt className={clsx("font-semibold", isSelected ? "text-slate-300" : "text-slate-500")}>Cost</dt>
                                <dd className="mt-1">{node.cost_estimate != null ? `$${node.cost_estimate.toFixed(4)}` : "-"}</dd>
                              </div>
                              <div>
                                <dt className={clsx("font-semibold", isSelected ? "text-slate-300" : "text-slate-500")}>Output</dt>
                                <dd className="mt-1 break-all">{artifact?.path ?? "Pending"}</dd>
                              </div>
                            </dl>
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    {selectedNode ? (
                      <div className="space-y-5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Node details
                            </p>
                            <h3 className="mt-2 text-2xl font-semibold text-slate-950">
                              {selectedNode.node_name}
                            </h3>
                            <p className="mt-1 text-sm text-slate-500">
                              {selectedNode.node_type} node for run {selectedRun.id}
                            </p>
                          </div>
                          <span className={clsx("rounded-full border px-3 py-2 text-sm font-semibold", statusTone(selectedNode.status))}>
                            {selectedNode.status}
                          </span>
                        </div>
                        <dl className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Model</dt>
                            <dd className="mt-1 break-words text-sm text-slate-900">{selectedNode.model_used ?? selectedNode.model_profile ?? "-"}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Token input</dt>
                            <dd className="mt-1 text-sm text-slate-900">{selectedNode.token_input ?? 0}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Token output</dt>
                            <dd className="mt-1 text-sm text-slate-900">{selectedNode.token_output ?? 0}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Cost</dt>
                            <dd className="mt-1 text-sm text-slate-900">{selectedNode.cost_estimate != null ? `$${selectedNode.cost_estimate.toFixed(4)}` : "-"}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Started</dt>
                            <dd className="mt-1 text-sm text-slate-900">{formatDateTime(selectedNode.started_at)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Completed</dt>
                            <dd className="mt-1 text-sm text-slate-900">{formatDateTime(selectedNode.completed_at)}</dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Artifact</dt>
                            <dd className="mt-1 break-all text-sm text-slate-900">{selectedNodeArtifact?.path ?? "-"}</dd>
                          </div>
                        </dl>

                        {selectedNode.error_message ? (
                          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {selectedNode.error_message}
                          </div>
                        ) : null}

                        <div className="grid gap-4 xl:grid-cols-2">
                          <section className="rounded-2xl border border-slate-200 p-4">
                            <h4 className="text-sm font-semibold text-slate-900">Input JSON</h4>
                            <div className="mt-3 overflow-auto rounded-xl bg-slate-50 p-3">
                              <JsonView collapsed={1} src={selectedNode.input_json ?? {}} />
                            </div>
                          </section>
                          <section className="rounded-2xl border border-slate-200 p-4">
                            <h4 className="text-sm font-semibold text-slate-900">Output JSON</h4>
                            <div className="mt-3 overflow-auto rounded-xl bg-slate-50 p-3">
                              <JsonView collapsed={1} src={selectedNode.output_json ?? {}} />
                            </div>
                          </section>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
                        Select a node to inspect its execution details.
                      </div>
                    )}
                  </div>
                </div>
              )
            ) : activeTab === "data" ? (
              selectedRun ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-xl font-semibold text-slate-950">Run state</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        The selected run state updates as each node completes.
                      </p>
                    </div>
                    <span className={clsx("rounded-full border px-3 py-2 text-xs font-semibold", statusTone(selectedRun.status))}>
                      {selectedRun.status}
                    </span>
                  </div>
                  <div className="mt-4 overflow-auto rounded-2xl bg-slate-50 p-4">
                    <JsonView collapsed={1} src={selectedRun.state_json ?? {}} />
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-8 text-center text-sm text-slate-500">
                  No run selected. Type a document request and click Run.
                </div>
              )
            ) : activeTab === "files" ? (
              <div className="space-y-6">
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-950">Project input files</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        Files uploaded to this project under input/.
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {projectInputFiles.length}
                    </span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {projectInputFiles.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                        No uploaded input files yet.
                      </div>
                    ) : (
                      projectInputFiles.map((artifact) => (
                        <article key={artifact.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <h4 className="text-sm font-semibold text-slate-950">{artifact.filename}</h4>
                              <p className="mt-1 break-all text-xs text-slate-500">{artifact.path}</p>
                              <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                                <span>{artifact.mime_type}</span>
                                <span>{formatBytes(artifact.size_bytes)}</span>
                                <span>{formatDateTime(artifact.created_at)}</span>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => loadArtifactPreview(artifact).catch((err) => setPreviewError(err instanceof Error ? err.message : "Preview failed."))}>Preview</button>
                              <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => void handleDownload(artifact)}>Download</button>
                              <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => navigator.clipboard.writeText(artifact.path).catch(() => undefined)}>Copy path</button>
                              <button className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => void handleDelete(artifact)}>Delete</button>
                            </div>
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-950">Selected run artifacts</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        Working, final, log, and archive files for the selected run.
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {selectedRun ? activeRunArtifacts.length : 0}
                    </span>
                  </div>

                  {!selectedRun ? (
                    <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      Select or create a run to inspect generated artifacts.
                    </div>
                  ) : (
                    <div className="mt-4 space-y-5">
                      {(["working", "final", "logs", "archive"] as ArtifactGroupKey[]).map((group) => (
                        <section key={group}>
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <h4 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              {group}
                            </h4>
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
                              {artifactGroups[group].length}
                            </span>
                          </div>
                          {artifactGroups[group].length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                              No {group} artifacts for this run.
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {artifactGroups[group].map((artifact) => (
                                <article key={artifact.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                    <div>
                                      <h5 className="text-sm font-semibold text-slate-950">{artifact.filename}</h5>
                                      <p className="mt-1 break-all text-xs text-slate-500">{artifact.path}</p>
                                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                                        <span>{artifact.mime_type}</span>
                                        <span>{formatBytes(artifact.size_bytes)}</span>
                                        <span>{formatDateTime(artifact.created_at)}</span>
                                      </div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => loadArtifactPreview(artifact).catch((err) => setPreviewError(err instanceof Error ? err.message : "Preview failed."))}>Preview</button>
                                      <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => void handleDownload(artifact)}>Download</button>
                                      <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => navigator.clipboard.writeText(artifact.path).catch(() => undefined)}>Copy path</button>
                                      <button className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => void handleDelete(artifact)}>Delete</button>
                                    </div>
                                  </div>
                                </article>
                              ))}
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                  )}
                </section>

                {previewArtifactId && previewUrl ? (
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold text-slate-950">Preview</h3>
                      <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={resetPreview}>Close preview</button>
                    </div>
                    {previewError ? (
                      <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {previewError}
                      </div>
                    ) : previewIsPdf ? (
                      <iframe className="mt-4 h-[520px] w-full rounded-2xl border border-slate-200 bg-white" src={previewUrl} />
                    ) : (
                      <pre className="mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                        {previewText}
                      </pre>
                    )}
                  </section>
                ) : null}
              </div>
            ) : activeTab === "output" ? (
              !selectedRun ? (
                <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-8 text-center text-sm text-slate-500">
                  No run selected.
                </div>
              ) : (
                <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-semibold text-slate-950">Output viewer</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        Final Markdown and PDF outputs for the selected run.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {(["markdown", "pdf"] as OutputViewer[]).map((viewer) => (
                        <button
                          key={viewer}
                          className={clsx(
                            "rounded-lg px-3 py-2 text-sm font-semibold",
                            outputViewer === viewer
                              ? "bg-slate-900 text-white"
                              : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          )}
                          onClick={() => setOutputViewer(viewer)}
                        >
                          {viewer === "markdown" ? "Markdown" : "PDF"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {previewError ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {previewError}
                    </div>
                  ) : outputViewer === "markdown" ? (
                    latestMarkdownArtifact ? (
                      <article className="prose prose-slate max-w-none rounded-2xl border border-slate-200 bg-slate-50 p-6">
                        <ReactMarkdown>{previewArtifactId === latestMarkdownArtifact.id ? previewText : ""}</ReactMarkdown>
                      </article>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                        {selectedRunActive
                          ? "Output will appear when final files are created."
                          : "No final markdown for this run."}
                      </div>
                    )
                  ) : latestPdfArtifact ? (
                    <iframe
                      className="h-[680px] w-full rounded-2xl border border-slate-200 bg-white"
                      src={previewArtifactId === latestPdfArtifact.id ? previewUrl : filePreviewPath(latestPdfArtifact.id)}
                    />
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                      {selectedRunActive ? "PDF will appear when generated." : "No final PDF for this run."}
                    </div>
                  )}
                </div>
              )
            ) : activeTab === "logs" ? (
              !selectedRun ? (
                <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-8 text-center text-sm text-slate-500">
                  Select a run to inspect logs.
                </div>
              ) : (
                <div className="space-y-6">
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-950">Run summary</h3>
                        <p className="mt-1 text-sm text-slate-500">Status, timestamps, and errors for the selected run.</p>
                      </div>
                      <span className={clsx("rounded-full border px-3 py-2 text-xs font-semibold", statusTone(selectedRun.status))}>
                        {selectedRun.status}
                      </span>
                    </div>
                    <dl className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Created</dt>
                        <dd className="mt-1 text-sm text-slate-900">{formatDateTime(selectedRun.created_at)}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Updated</dt>
                        <dd className="mt-1 text-sm text-slate-900">{formatDateTime(selectedRun.updated_at)}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Completed</dt>
                        <dd className="mt-1 text-sm text-slate-900">{formatDateTime(selectedRun.completed_at)}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Events</dt>
                        <dd className="mt-1 text-sm text-slate-900">{selectedRun.events.length}</dd>
                      </div>
                    </dl>
                    {selectedRun.error_message ? (
                      <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {selectedRun.error_message}
                      </div>
                    ) : null}
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-lg font-semibold text-slate-950">Run events</h3>
                    {(selectedRun.events ?? []).length === 0 ? (
                      <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                        No events yet.
                      </div>
                    ) : (
                      <div className="mt-4 space-y-3">
                        {selectedRun.events.map((event) => (
                          <article key={event.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm font-semibold text-slate-950">{event.type}</p>
                              <span className="text-xs text-slate-500">{formatDateTime(event.created_at)}</span>
                            </div>
                            <pre className="mt-3 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs leading-5 text-slate-700">
                              {JSON.stringify(event.event_json, null, 2)}
                            </pre>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-lg font-semibold text-slate-950">Node executions</h3>
                    {pipelineNodes.length === 0 ? (
                      <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                        No node execution records for this run.
                      </div>
                    ) : (
                      <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
                        <table className="min-w-full text-left text-sm text-slate-700">
                          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            <tr>
                              <th className="px-4 py-3">Node</th>
                              <th className="px-4 py-3">Status</th>
                              <th className="px-4 py-3">Model</th>
                              <th className="px-4 py-3">Input</th>
                              <th className="px-4 py-3">Output</th>
                              <th className="px-4 py-3">Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pipelineNodes.map((node: NodeExecution) => (
                              <tr key={node.id} className="border-t border-slate-200">
                                <td className="px-4 py-3 font-medium text-slate-950">{node.node_name}</td>
                                <td className="px-4 py-3">{node.status}</td>
                                <td className="px-4 py-3 break-words">{node.model_used ?? node.model_profile ?? "-"}</td>
                                <td className="px-4 py-3">{node.token_input ?? 0}</td>
                                <td className="px-4 py-3">{node.token_output ?? 0}</td>
                                <td className="px-4 py-3">{node.cost_estimate != null ? `$${node.cost_estimate.toFixed(4)}` : "-"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </div>
              )
            ) : selectedRun ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-xl font-semibold text-slate-950">Run state</h3>
                <p className="mt-1 text-sm text-slate-500">The selected run state is available in the Data Inspector tab.</p>
                <div className="mt-4 overflow-auto rounded-2xl bg-slate-50 p-4">
                  <JsonView collapsed={1} src={selectedRun.state_json ?? {}} />
                </div>
              </div>
            ) : (
              <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white px-8 text-center text-sm text-slate-500">
                No run selected.
              </div>
            )}
          </div>
        </section>
      </div>

      <DeleteProjectModal
        open={deleteModalOpen}
        project={selectedProject}
        onClose={() => setDeleteModalOpen(false)}
        onDeleted={(deletedId) => {
          setProjects((current) => current.filter((project) => project.id !== deletedId));
          if (selectedProjectId === deletedId) {
            setSelectedProjectId("");
            setSelectedRunId("");
            setSelectedRun(null);
            setRuns([]);
            setFiles([]);
            setMessages([]);
            resetPreview();
          }
        }}
      />
    </main>
  );
}

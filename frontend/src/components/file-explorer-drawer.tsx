"use client";

import clsx from "clsx";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_BASE, Artifact, Project, VaultItem, VaultFoldersResponse, apiFetch } from "@/lib/api";

const PROJECT_GROUPS = ["input", "working", "final", "logs", "archive"] as const;
type ProjectGroup = (typeof PROJECT_GROUPS)[number];

type Tab = "project" | "vault";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime.includes("pdf")) return "📕";
  if (mime.includes("json")) return "{ }";
  if (mime.includes("markdown") || mime.includes("text/")) return "📄";
  if (mime.includes("zip") || mime.includes("compressed")) return "🗜";
  return "📁";
}

export type FileExplorerDrawerProps = {
  open: boolean;
  onClose: () => void;
  initialTab?: Tab;
  /** Active project for the "This project" tab. If null, the project tab is hidden. */
  project: Project | null;
  /** Optional callback when a vault item is added/changed so the parent can refresh. */
  onVaultChanged?: () => void;
  /** Optional callback when a project file is deleted/changed. */
  onProjectFilesChanged?: () => void;
};

export default function FileExplorerDrawer({
  open,
  onClose,
  initialTab = "project",
  project,
  onVaultChanged,
  onProjectFilesChanged,
}: FileExplorerDrawerProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Project files state
  const [projectFiles, setProjectFiles] = useState<Artifact[]>([]);
  const [projectGroup, setProjectGroup] = useState<ProjectGroup | "all">("all");
  const [projectLoading, setProjectLoading] = useState(false);

  // Vault state
  const [vaultItems, setVaultItems] = useState<VaultItem[]>([]);
  const [vaultFolders, setVaultFolders] = useState<string[]>(["/"]);
  const [vaultFolder, setVaultFolder] = useState("/");
  const [vaultLoading, setVaultLoading] = useState(false);
  const vaultUploadRef = useRef<HTMLInputElement | null>(null);

  // Selected item for action footer (project or vault)
  const [selectedKey, setSelectedKey] = useState<string>("");

  const reloadProject = useCallback(async () => {
    if (!project) return;
    setProjectLoading(true);
    setError(null);
    try {
      const list = await apiFetch<Artifact[]>(`/projects/${project.id}/files`);
      setProjectFiles(list.filter((file) => file.deleted_at === null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project files.");
    } finally {
      setProjectLoading(false);
    }
  }, [project]);

  const reloadVault = useCallback(async () => {
    setVaultLoading(true);
    setError(null);
    try {
      const items = await apiFetch<VaultItem[]>("/vault");
      setVaultItems(items);
      const folders = await apiFetch<VaultFoldersResponse>("/vault/folders");
      const list = folders.folders?.length ? folders.folders : ["/"];
      setVaultFolders(list);
      if (!list.includes(vaultFolder)) setVaultFolder("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vault.");
    } finally {
      setVaultLoading(false);
    }
  }, [vaultFolder]);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelectedKey("");
    setError(null);
    void reloadProject();
    void reloadVault();
  }, [open, initialTab, reloadProject, reloadVault]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const projectFilesFiltered = useMemo(() => {
    let list = projectFiles;
    if (projectGroup !== "all") {
      list = list.filter((file) => file.path.startsWith(`${projectGroup}/`));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (file) =>
          file.filename.toLowerCase().includes(q) || file.path.toLowerCase().includes(q)
      );
    }
    return list;
  }, [projectFiles, projectGroup, search]);

  const vaultItemsFiltered = useMemo(() => {
    let list = vaultItems;
    if (vaultFolder && vaultFolder !== "(all)") {
      list = list.filter((item) => item.folder === vaultFolder);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (item) =>
          item.name.toLowerCase().includes(q) || item.notes.toLowerCase().includes(q)
      );
    }
    return list;
  }, [vaultItems, vaultFolder, search]);

  const selectedProjectArtifact = useMemo(
    () => projectFiles.find((f) => f.id === selectedKey) ?? null,
    [projectFiles, selectedKey]
  );
  const selectedVaultItem = useMemo(
    () => vaultItems.find((v) => v.id === selectedKey) ?? null,
    [vaultItems, selectedKey]
  );

  // Actions
  const downloadArtifact = async (artifact: Artifact) => {
    try {
      const { download_url } = await apiFetch<{ download_url: string }>(
        `/artifacts/${artifact.id}/download-url`
      );
      window.open(download_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    }
  };

  const previewArtifact = (artifact: Artifact) => {
    window.open(`${API_BASE}/artifacts/${artifact.id}/content`, "_blank", "noopener,noreferrer");
  };

  const deleteArtifact = async (artifact: Artifact) => {
    if (!confirm(`Delete ${artifact.filename} from the project? This removes it from R2.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/artifacts/${artifact.id}`, { method: "DELETE" });
      setSelectedKey("");
      await reloadProject();
      onProjectFilesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveArtifactToVault = async (artifact: Artifact) => {
    setBusy(true);
    setError(null);
    try {
      const folder = window.prompt(
        "Save to vault folder (e.g. /Proposals or just /)",
        vaultFolder || "/"
      );
      if (folder === null) return;
      await apiFetch<VaultItem>("/vault/from-artifact", {
        method: "POST",
        body: JSON.stringify({
          artifact_id: artifact.id,
          name: artifact.filename,
          folder: folder.trim() || "/",
          notes: project ? `From project ${project.name} · ${artifact.path}` : "",
        }),
      });
      await reloadVault();
      onVaultChanged?.();
      // Brief feedback by switching to vault tab so user sees the result
      setTab("vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save to vault failed.");
    } finally {
      setBusy(false);
    }
  };

  const downloadVaultItem = async (item: VaultItem) => {
    try {
      const { download_url } = await apiFetch<{ download_url: string }>(
        `/vault/${item.id}/download-url`
      );
      window.open(download_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    }
  };

  const previewVaultItem = (item: VaultItem) => {
    window.open(`${API_BASE}/vault/${item.id}/content`, "_blank", "noopener,noreferrer");
  };

  const deleteVaultItem = async (item: VaultItem) => {
    if (!confirm(`Permanently delete "${item.name}" from your vault?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/vault/${item.id}`, { method: "DELETE" });
      setSelectedKey("");
      await reloadVault();
      onVaultChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  const renameVaultItem = async (item: VaultItem) => {
    const next = window.prompt("Rename file", item.name);
    if (next === null || !next.trim() || next === item.name) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<VaultItem>(`/vault/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: next.trim() }),
      });
      await reloadVault();
      onVaultChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed.");
    } finally {
      setBusy(false);
    }
  };

  const moveVaultItem = async (item: VaultItem) => {
    const next = window.prompt("Move to folder (e.g. /Q2 Proposals)", item.folder);
    if (next === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<VaultItem>(`/vault/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ folder: next.trim() || "/" }),
      });
      await reloadVault();
      onVaultChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleVaultUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const presign = await apiFetch<{ upload_url: string; item_id: string; storage_key: string }>(
          "/vault/upload-url",
          {
            method: "POST",
            body: JSON.stringify({
              name: file.name,
              mime_type: file.type || "application/octet-stream",
              folder: vaultFolder || "/",
            }),
          }
        );
        const uploadResponse = await fetch(presign.upload_url, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!uploadResponse.ok) throw new Error(`Upload failed for ${file.name}`);
        await apiFetch<VaultItem>("/vault/confirm-upload", {
          method: "POST",
          body: JSON.stringify({
            item_id: presign.item_id,
            name: file.name,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size,
            folder: vaultFolder || "/",
          }),
        });
      }
      await reloadVault();
      onVaultChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close file explorer"
        className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <section
        role="dialog"
        aria-modal="true"
        className="absolute inset-x-0 bottom-0 flex h-[78vh] max-h-[860px] flex-col rounded-t-3xl border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Drag handle / header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <div className="mx-auto mb-2 h-1 w-12 rounded-full bg-slate-200" />
            <h2 className="text-lg font-semibold text-slate-950">Files & Vault</h2>
            <p className="text-xs text-slate-500">
              Project files live with the project. Vault files are permanent and survive project
              deletion.
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {/* Tabs + search */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-semibold transition",
                tab === "project"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-800",
                !project && "cursor-not-allowed opacity-50"
              )}
              disabled={!project}
              onClick={() => setTab("project")}
            >
              {project ? `Project: ${project.name}` : "No project selected"}
            </button>
            <button
              type="button"
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-semibold transition",
                tab === "vault"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-800"
              )}
              onClick={() => setTab("vault")}
            >
              My Vault
              <span className="ml-2 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700">
                {vaultItems.length}
              </span>
            </button>
          </div>
          <input
            type="search"
            placeholder="Search files…"
            className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}

        {/* Body */}
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
          {/* Sidebar / folder filter */}
          <aside className="overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
            {tab === "project" ? (
              <>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Folders
                </p>
                <ul className="space-y-1">
                  <FolderRow
                    label="All"
                    active={projectGroup === "all"}
                    count={projectFiles.length}
                    onClick={() => setProjectGroup("all")}
                  />
                  {PROJECT_GROUPS.map((g) => (
                    <FolderRow
                      key={g}
                      label={`/${g}`}
                      active={projectGroup === g}
                      count={projectFiles.filter((f) => f.path.startsWith(`${g}/`)).length}
                      onClick={() => setProjectGroup(g)}
                    />
                  ))}
                </ul>
                <p className="mt-4 text-[10px] text-slate-500">
                  These folders live in this project's R2 prefix:
                </p>
                <p className="mt-1 break-all rounded-md bg-white px-2 py-1 font-mono text-[10px] text-slate-700">
                  {project?.r2_root_prefix ?? "—"}
                </p>
              </>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Folders
                  </p>
                  <button
                    type="button"
                    className="text-[10px] font-semibold text-blue-600 hover:underline"
                    onClick={async () => {
                      const next = window.prompt(
                        "New folder path (e.g. /Q2 Proposals)",
                        "/"
                      );
                      if (next === null) return;
                      const cleaned = next.trim() || "/";
                      if (!vaultFolders.includes(cleaned)) {
                        setVaultFolders((prev) => Array.from(new Set([...prev, cleaned])).sort());
                      }
                      setVaultFolder(cleaned);
                    }}
                  >
                    + Folder
                  </button>
                </div>
                <ul className="space-y-1">
                  {vaultFolders.map((f) => (
                    <FolderRow
                      key={f}
                      label={f}
                      active={vaultFolder === f}
                      count={vaultItems.filter((item) => item.folder === f).length}
                      onClick={() => setVaultFolder(f)}
                    />
                  ))}
                </ul>
                <input
                  ref={vaultUploadRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleVaultUpload}
                />
                <button
                  type="button"
                  className="mt-4 w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
                  disabled={busy}
                  onClick={() => vaultUploadRef.current?.click()}
                >
                  {busy ? "Working…" : "Upload to vault"}
                </button>
              </>
            )}
          </aside>

          {/* File list */}
          <div className="min-h-0 overflow-y-auto">
            {tab === "project" ? (
              <ProjectFileList
                loading={projectLoading}
                files={projectFilesFiltered}
                selectedId={selectedKey}
                onSelect={setSelectedKey}
              />
            ) : (
              <VaultFileList
                loading={vaultLoading}
                items={vaultItemsFiltered}
                selectedId={selectedKey}
                onSelect={setSelectedKey}
              />
            )}
          </div>
        </div>

        {/* Action footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div className="min-w-0 flex-1 truncate text-xs text-slate-600">
            {tab === "project" && selectedProjectArtifact ? (
              <span>
                <span className="font-semibold">{selectedProjectArtifact.filename}</span> ·{" "}
                <span className="font-mono">{selectedProjectArtifact.path}</span> ·{" "}
                {formatBytes(selectedProjectArtifact.size_bytes)}
              </span>
            ) : tab === "vault" && selectedVaultItem ? (
              <span>
                <span className="font-semibold">{selectedVaultItem.name}</span> ·{" "}
                <span className="font-mono">{selectedVaultItem.folder}</span> ·{" "}
                {formatBytes(selectedVaultItem.size_bytes)}
              </span>
            ) : (
              <span className="text-slate-400">Select a file to act on it.</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {tab === "project" && selectedProjectArtifact ? (
              <>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => previewArtifact(selectedProjectArtifact)}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => downloadArtifact(selectedProjectArtifact)}
                >
                  Download
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => saveArtifactToVault(selectedProjectArtifact)}
                >
                  Save to Vault
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => deleteArtifact(selectedProjectArtifact)}
                >
                  Delete
                </button>
              </>
            ) : null}
            {tab === "vault" && selectedVaultItem ? (
              <>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => previewVaultItem(selectedVaultItem)}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => downloadVaultItem(selectedVaultItem)}
                >
                  Download
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => renameVaultItem(selectedVaultItem)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => moveVaultItem(selectedVaultItem)}
                >
                  Move
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => deleteVaultItem(selectedVaultItem)}
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}

function FolderRow({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={clsx(
          "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs",
          active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white"
        )}
        onClick={onClick}
      >
        <span className="truncate font-mono">{label}</span>
        <span
          className={clsx(
            "rounded-full px-1.5 py-0.5 text-[10px]",
            active ? "bg-white/20" : "bg-slate-200 text-slate-700"
          )}
        >
          {count}
        </span>
      </button>
    </li>
  );
}

function ProjectFileList({
  loading,
  files,
  selectedId,
  onSelect,
}: {
  loading: boolean;
  files: Artifact[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading project files…</div>;
  }
  if (!files.length) {
    return <div className="p-6 text-sm text-slate-500">No files in this folder.</div>;
  }
  return (
    <table className="w-full table-fixed text-left text-sm">
      <thead className="sticky top-0 bg-slate-50 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <tr>
          <th className="w-[42%] px-4 py-2">Name</th>
          <th className="w-[28%] px-4 py-2">Path</th>
          <th className="w-[10%] px-4 py-2">Size</th>
          <th className="w-[20%] px-4 py-2">Created</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => {
          const active = file.id === selectedId;
          return (
            <tr
              key={file.id}
              className={clsx(
                "cursor-pointer border-b border-slate-100 transition",
                active ? "bg-blue-50" : "hover:bg-slate-50"
              )}
              onClick={() => onSelect(file.id)}
              onDoubleClick={() => onSelect(file.id)}
            >
              <td className="truncate px-4 py-2">
                <span className="mr-2 inline-block w-5 text-center">{fileIcon(file.mime_type)}</span>
                <span className="font-medium text-slate-900">{file.filename}</span>
              </td>
              <td className="truncate px-4 py-2 font-mono text-[11px] text-slate-600">{file.path}</td>
              <td className="px-4 py-2 text-xs text-slate-600">{formatBytes(file.size_bytes)}</td>
              <td className="truncate px-4 py-2 text-xs text-slate-600">
                {formatDate(file.created_at)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function VaultFileList({
  loading,
  items,
  selectedId,
  onSelect,
}: {
  loading: boolean;
  items: VaultItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading vault…</div>;
  }
  if (!items.length) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Vault is empty for this folder. Push project outputs here from the Project tab, or click
        Upload to vault on the left.
      </div>
    );
  }
  return (
    <table className="w-full table-fixed text-left text-sm">
      <thead className="sticky top-0 bg-slate-50 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <tr>
          <th className="w-[36%] px-4 py-2">Name</th>
          <th className="w-[20%] px-4 py-2">Folder</th>
          <th className="w-[10%] px-4 py-2">Size</th>
          <th className="w-[16%] px-4 py-2">Source</th>
          <th className="w-[18%] px-4 py-2">Saved</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const active = item.id === selectedId;
          return (
            <tr
              key={item.id}
              className={clsx(
                "cursor-pointer border-b border-slate-100 transition",
                active ? "bg-blue-50" : "hover:bg-slate-50"
              )}
              onClick={() => onSelect(item.id)}
            >
              <td className="truncate px-4 py-2">
                <span className="mr-2 inline-block w-5 text-center">{fileIcon(item.mime_type)}</span>
                <span className="font-medium text-slate-900">{item.name}</span>
              </td>
              <td className="truncate px-4 py-2 font-mono text-[11px] text-slate-600">
                {item.folder}
              </td>
              <td className="px-4 py-2 text-xs text-slate-600">{formatBytes(item.size_bytes)}</td>
              <td className="truncate px-4 py-2 text-[11px] text-slate-500">
                {item.source_project_id ? "From project" : "Direct upload"}
              </td>
              <td className="truncate px-4 py-2 text-xs text-slate-600">
                {formatDate(item.created_at)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

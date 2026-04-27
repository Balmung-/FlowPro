"use client";

import { useEffect, useState } from "react";

import { Project, VaultItem, apiFetch } from "@/lib/api";

type DeleteResult = {
  deleted: boolean;
  project_id: string;
  deleted_objects: number;
  deleted_vault_items: number;
  storage_warning?: string;
  vault_storage_warnings?: string[];
};

export type DeleteProjectModalProps = {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onDeleted: (projectId: string) => void;
};

export default function DeleteProjectModal({
  open,
  project,
  onClose,
  onDeleted,
}: DeleteProjectModalProps) {
  const [loadingVault, setLoadingVault] = useState(false);
  const [vaultItems, setVaultItems] = useState<VaultItem[]>([]);
  const [cascadeVault, setCascadeVault] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    setCascadeVault(false);
    setConfirmText("");
    setError(null);
    setLoadingVault(true);
    apiFetch<VaultItem[]>(`/vault?source_project_id=${encodeURIComponent(project.id)}`)
      .then(setVaultItems)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load vault items.");
      })
      .finally(() => setLoadingVault(false));
  }, [open, project]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open || !project) return null;

  const matchesName = confirmText.trim() === project.name.trim();

  async function handleConfirm() {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const params = cascadeVault ? "?cascade_vault=true" : "";
      const result = await apiFetch<DeleteResult>(`/projects/${project.id}${params}`, {
        method: "DELETE",
      });
      if (result.storage_warning || result.vault_storage_warnings?.length) {
        // Surface partial-cleanup warnings but treat as success since the DB row is gone.
        const summary = [
          result.storage_warning,
          ...(result.vault_storage_warnings ?? []).map((w) => `Vault: ${w}`),
        ]
          .filter(Boolean)
          .join(" · ");
        console.warn("Project deleted with storage warnings:", summary);
      }
      onDeleted(project.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
        onClick={() => !busy && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute left-1/2 top-1/2 w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="border-b border-slate-200 bg-red-50 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700">
            Permanent action
          </p>
          <h2 className="mt-0.5 text-lg font-semibold text-slate-950">
            Delete project &ldquo;{project.name}&rdquo;?
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            All run history, chat, and the project's <span className="font-mono">{project.r2_root_prefix}</span>{" "}
            files in cloud storage will be permanently removed.
          </p>
        </header>

        <div className="space-y-4 px-5 py-4">
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-semibold text-slate-800">Will be deleted</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-slate-700">
              <li>Every project file under <code className="font-mono">{project.r2_root_prefix}</code> in R2</li>
              <li>All runs, node executions, run events, and chat messages</li>
              <li>All artifact records linked to this project</li>
            </ul>
          </section>

          <section>
            <p className="text-xs font-semibold text-slate-800">
              Vault items copied from this project
              {!loadingVault ? (
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                  {vaultItems.length}
                </span>
              ) : null}
            </p>
            {loadingVault ? (
              <p className="mt-1 text-xs text-slate-500">Checking your vault…</p>
            ) : vaultItems.length === 0 ? (
              <p className="mt-1 text-xs text-slate-500">
                No vault items were saved from this project. Your vault is unaffected.
              </p>
            ) : (
              <>
                <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                  {vaultItems.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                      <span className="truncate font-medium text-slate-800">{item.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500">{item.folder}</span>
                    </li>
                  ))}
                </ul>
                <label
                  className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={cascadeVault}
                    disabled={busy}
                    onChange={(e) => setCascadeVault(e.target.checked)}
                  />
                  <span>
                    <span className="font-semibold text-amber-900">
                      Also delete these {vaultItems.length} Vault items
                    </span>
                    <span className="block text-[10px] text-amber-800">
                      Without this, the vault items survive and stay accessible after the project is gone.
                      With it, those exact files (and only those) are permanently removed from your vault.
                    </span>
                  </span>
                </label>
              </>
            )}
          </section>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          ) : null}

          <section>
            <label className="text-xs font-semibold text-slate-800">
              Type the project name to confirm
            </label>
            <p className="mt-0.5 text-[10px] text-slate-500">
              Type{" "}
              <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700">
                {project.name}
              </span>{" "}
              exactly to enable the delete button.
            </p>
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              placeholder={project.name}
              value={confirmText}
              disabled={busy}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          </section>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy || !matchesName}
            onClick={() => void handleConfirm()}
          >
            {busy
              ? "Deleting…"
              : cascadeVault && vaultItems.length > 0
                ? `Delete project + ${vaultItems.length} vault items`
                : "Delete project"}
          </button>
        </footer>
      </div>
    </div>
  );
}

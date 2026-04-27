"use client";

import Link from "next/link";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Template, apiFetch } from "@/lib/api";
import { getStoredToken } from "@/lib/auth";

export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await apiFetch<Template[]>("/templates");
      setTemplates(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!getStoredToken()) {
      router.replace("/login");
      return;
    }
    void load();
  }, [router]);

  async function handleClone(template: Template) {
    setError(null);
    try {
      const clone = await apiFetch<Template>(`/templates/${template.id}/clone`, { method: "POST" });
      router.push(`/templates/${clone.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed.");
    }
  }

  async function handleDelete(template: Template) {
    if (template.is_seeded) return;
    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await apiFetch(`/templates/${template.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 text-xs">
              <Link className="font-medium text-slate-500 hover:underline" href="/workspace">
                ← Workspace (chat)
              </Link>
              <span className="text-slate-300">/</span>
              <span className="font-medium text-slate-700">Templates</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-slate-950">Templates</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              A template is the workflow that runs when a user chats in a project. Each node calls
              an OpenRouter model and writes a file the next node can read. To <strong>use</strong>{" "}
              a template, go to the <Link className="text-blue-600 hover:underline" href="/workspace">workspace</Link>,
              create a project that picks this template, and chat.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
              href="/workspace"
            >
              💬 Open chat
            </Link>
            <Link
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm"
              href="/templates/new"
            >
              + New template
            </Link>
          </div>
        </div>

        {error ? (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-8">
          {loading ? (
            <p className="text-sm text-slate-500">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
              No templates yet.
            </p>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {templates.map((template) => {
                const nodeCount = template.config_json?.nodes?.length ?? 0;
                return (
                  <li
                    key={template.id}
                    className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold text-slate-950">{template.name}</h2>
                          <p className="mt-0.5 font-mono text-[10px] text-slate-500">{template.slug}</p>
                        </div>
                        {template.is_seeded ? (
                          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                            Seeded
                          </span>
                        ) : null}
                      </div>
                      {template.description ? (
                        <p className="mt-3 text-sm text-slate-600">{template.description}</p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span>{nodeCount} node{nodeCount === 1 ? "" : "s"}</span>
                        {template.config_json?.default_viewer ? (
                          <span>Default viewer: {template.config_json.default_viewer}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-5 flex flex-wrap gap-2">
                      <Link
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        href={`/templates/${template.id}`}
                      >
                        {template.is_seeded ? "View" : "Edit"}
                      </Link>
                      <button
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => void handleClone(template)}
                      >
                        Clone
                      </button>
                      <button
                        className={clsx(
                          "rounded-lg border px-3 py-1.5 text-xs font-semibold",
                          template.is_seeded
                            ? "border-slate-100 bg-slate-50 text-slate-400"
                            : "border-red-200 bg-white text-red-700 hover:bg-red-50"
                        )}
                        disabled={template.is_seeded}
                        onClick={() => void handleDelete(template)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

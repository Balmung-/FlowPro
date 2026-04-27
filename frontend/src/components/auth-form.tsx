"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { setAuthSession } from "@/lib/auth";

type AuthFormProps = {
  mode: "login" | "register";
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = mode === "register" ? { email, password, name } : { email, password };
      const response = await apiFetch<{ token: string }>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setAuthSession(response.token);
      router.push("/workspace");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-edge bg-white p-8 shadow-sm">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{mode === "login" ? "Sign in" : "Create account"}</h1>
        <p className="mt-2 text-sm text-slate-500">Internal access for the document cockpit.</p>
      </div>
      {mode === "register" ? (
        <label className="block text-sm text-slate-700">
          Name
          <input className="mt-1 w-full rounded-xl border border-edge px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
      ) : null}
      <label className="block text-sm text-slate-700">
        Email
        <input className="mt-1 w-full rounded-xl border border-edge px-3 py-2" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </label>
      <label className="block text-sm text-slate-700">
        Password
        <input className="mt-1 w-full rounded-xl border border-edge px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      </label>
      {error ? <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      <button className="w-full rounded-xl bg-ink px-4 py-3 text-sm font-medium text-white disabled:opacity-60" disabled={submitting} type="submit">
        {submitting ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
      </button>
    </form>
  );
}


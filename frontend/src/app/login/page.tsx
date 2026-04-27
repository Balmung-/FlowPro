import Link from "next/link";

import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <AuthForm mode="login" />
        <p className="text-center text-sm text-slate-600">
          Need an account? <Link className="font-medium text-ink" href="/register">Register</Link>
        </p>
      </div>
    </main>
  );
}


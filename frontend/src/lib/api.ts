import { getStoredToken } from "@/lib/auth";

export const API_BASE = "/api/proxy";

export type User = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

export type Project = {
  id: string;
  user_id: string;
  template_id: string | null;
  name: string;
  description: string;
  r2_root_prefix: string;
  created_at: string;
  updated_at: string;
};

export type ViewerKind = "markdown" | "pdf" | "json" | "raw";

export type NodeOutputFormat = "json" | "markdown" | "pdf";

export type TemplateNodeType = "ai" | "plan" | "pdf_generator";

export type TemplateNodeConfig = {
  id: string;
  name: string;
  type: TemplateNodeType;
  model?: string | null;
  model_profile?: string | null;
  system_prompt: string;
  user_prompt_template: string;
  reads: string[];
  output: {
    format: NodeOutputFormat;
    path: string;
    state_section: string;
    state_key: string;
  };
  mock_content?: unknown;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterModelsResponse = {
  data: OpenRouterModel[];
  cached?: boolean;
  stale?: boolean;
};

export type TemplateConfig = {
  name: string;
  description?: string;
  default_viewer?: ViewerKind;
  allowed_viewers?: ViewerKind[];
  nodes: TemplateNodeConfig[];
};

export type Template = {
  id: string;
  slug: string;
  name: string;
  description: string;
  config_json: TemplateConfig;
  is_seeded: boolean;
  created_at: string;
  updated_at: string;
};

export type ModelProfile = {
  slug: string;
  primary: string | null;
  fallback: string | null;
};

export type ModelProfilesResponse = {
  profiles: ModelProfile[];
};

export type ChatMessage = {
  id: string;
  project_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

export type Artifact = {
  id: string;
  project_id: string;
  run_id: string | null;
  node_id: string | null;
  path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_by: "user" | "node" | "system";
  deleted_at: string | null;
  created_at: string;
};

export type Run = {
  id: string;
  project_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  input_message: string;
  state_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_message: string | null;
};

export type NodeExecution = {
  id: string;
  run_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  status: "waiting" | "running" | "completed" | "failed" | "skipped";
  model_profile: string | null;
  model_used: string | null;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown>;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  token_input: number | null;
  token_output: number | null;
  cost_estimate: number | null;
};

export type RunEvent = {
  id: string;
  run_id: string;
  type: string;
  event_json: Record<string, unknown>;
  created_at: string;
};

export type RunDetail = Run & {
  artifacts: Artifact[];
  events: RunEvent[];
  node_executions: NodeExecution[];
};

export async function apiFetch<T>(path: string, init?: RequestInit, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getStoredToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const body = await response.text();
    let detail: string | null = null;
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      detail = parsed.detail ?? null;
    } catch {}
    if (detail) {
      throw new Error(detail);
    }
    throw new Error(body || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const RAW_API_BASE_URL = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

function normalizeApiBaseUrl(rawValue: string): string {
  const value = rawValue.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
  if (!value) {
    throw new Error("Frontend API upstream is not configured. Set API_BASE_URL or NEXT_PUBLIC_API_BASE_URL.");
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`Unsupported API base URL scheme: ${value}`);
  }

  const useHttp =
    value.startsWith("localhost")
    || value.startsWith("127.0.0.1")
    || value.includes(".internal")
    || !value.includes(".");

  const normalized = `${useHttp ? "http" : "https"}://${value}`;
  new URL(normalized);
  return normalized;
}

export function getApiServerBaseUrl(): string {
  return normalizeApiBaseUrl(RAW_API_BASE_URL);
}

export function getApiServerBaseUrlStatus(): { ok: true; url: string } | { ok: false; detail: string } {
  try {
    return { ok: true, url: getApiServerBaseUrl() };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Frontend API upstream configuration is invalid.",
    };
  }
}

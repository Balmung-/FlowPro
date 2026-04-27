import { getApiServerBaseUrlStatus } from "@/lib/server-api-base";

export async function GET() {
  const apiBaseUrl = getApiServerBaseUrlStatus();
  if (!apiBaseUrl.ok) {
    return Response.json({ status: "error", detail: apiBaseUrl.detail }, { status: 503 });
  }
  return Response.json({ status: "ok", api_upstream: apiBaseUrl.url });
}

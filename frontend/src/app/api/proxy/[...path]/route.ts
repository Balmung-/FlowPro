import { NextRequest } from "next/server";

const UPSTREAM_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
export const dynamic = "force-dynamic";

function buildUpstreamUrl(path: string[], request: NextRequest): string {
  if (!UPSTREAM_BASE) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is not configured for the frontend runtime.");
  }

  const upstream = new URL(`${UPSTREAM_BASE.replace(/\/+$/, "")}/${path.join("/")}`);
  request.nextUrl.searchParams.forEach((value, key) => {
    upstream.searchParams.append(key, value);
  });
  return upstream.toString();
}

async function proxy(request: NextRequest, context: { params: { path: string[] } }): Promise<Response> {
  const { path } = context.params;
  const url = buildUpstreamUrl(path, request);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  const upstream = await fetch(url, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");
  responseHeaders.set("x-flowpro-proxy", "1");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

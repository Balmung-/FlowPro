import { NextRequest } from "next/server";

import { getApiServerBaseUrl } from "@/lib/server-api-base";

export const dynamic = "force-dynamic";

function buildUpstreamUrl(path: string[], request: NextRequest): string {
  const upstream = new URL(`${getApiServerBaseUrl()}/${path.join("/")}`);
  request.nextUrl.searchParams.forEach((value, key) => {
    upstream.searchParams.append(key, value);
  });
  return upstream.toString();
}

function copySafeResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  const contentType = source.get("content-type");
  const cacheControl = source.get("cache-control");
  const location = source.get("location");

  if (contentType) {
    headers.set("content-type", contentType);
  }
  if (cacheControl) {
    headers.set("cache-control", cacheControl);
  }
  if (location) {
    headers.set("location", location);
  }

  headers.set("x-flowpro-proxy", "1");
  return headers;
}

async function proxy(request: NextRequest, context: { params: { path: string[] } }): Promise<Response> {
  try {
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

    const payload = request.method === "HEAD" ? null : await upstream.arrayBuffer();

    return new Response(payload, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copySafeResponseHeaders(upstream.headers),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Frontend API proxy failed.";
    return Response.json({ detail: message }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

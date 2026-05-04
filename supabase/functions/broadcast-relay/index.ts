// Broadcast relay: pull from our internal HLS/PLS queue and PUSH to an external
// Icecast server using HTTP PUT (Icecast >= 2.4 source protocol over HTTP).
//
// Limits: edge functions have a max wall-clock duration. This is a best-effort
// "session" relay (typically up to a few minutes per invocation). For true 24/7
// relays, point a tool like BUTT, Liquidsoap, or ezstream at the public HLS
// stream we already expose.
//
// Endpoints:
//   POST /broadcast-relay/start    body: { targetId }
//     -> validates JWT, fetches target row, opens PUT to Icecast, streams MP3
//        segments until the request times out or client disconnects.
//   POST /broadcast-relay/test     body: { targetId }
//     -> just checks credentials by sending an empty PUT and reading the response.
//
// Shoutcast v1 (raw TCP, ICY protocol) is NOT supported here — must be relayed
// from a desktop client. Shoutcast v2 over HTTP also works with PUT.

import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2.95.0/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface BroadcastTarget {
  id: string;
  radio_id: string;
  name: string;
  protocol: "icecast" | "shoutcast";
  host: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  bitrate_kbps: number;
  use_tls: boolean;
}

function targetUrl(t: BroadcastTarget): string {
  const scheme = t.use_tls ? "https" : "http";
  const mount = t.mount.startsWith("/") ? t.mount : "/" + t.mount;
  return `${scheme}://${t.host}:${t.port}${mount}`;
}

function authHeader(t: BroadcastTarget): string {
  return "Basic " + btoa(`${t.username}:${t.password}`);
}

async function authClient(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const supa = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data } = await supa.auth.getClaims(auth.replace("Bearer ", ""));
  if (!data?.claims?.sub) return null;
  return { supa, userId: data.claims.sub as string };
}

async function loadTarget(targetId: string, userId: string): Promise<BroadcastTarget | null> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tgt } = await admin
    .from("broadcast_targets")
    .select("*, radio:radios(user_id)")
    .eq("id", targetId)
    .maybeSingle();
  if (!tgt) return null;
  // ownership check
  // deno-lint-ignore no-explicit-any
  if ((tgt as any).radio?.user_id !== userId) return null;
  return tgt as unknown as BroadcastTarget;
}

async function fetchInternalQueue(slug: string): Promise<{ url: string; durationSec: number; title: string }[]> {
  const url = `${SUPABASE_URL}/functions/v1/stream/${encodeURIComponent(slug)}.json`;
  const r = await fetch(url, { headers: { apikey: ANON_KEY } });
  if (!r.ok) return [];
  try {
    const j = await r.json();
    return Array.isArray(j?.queue) ? j.queue : [];
  } catch { return []; }
}

async function radioSlug(radioId: string): Promise<string | null> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data } = await admin.from("radios").select("slug").eq("id", radioId).maybeSingle();
  return (data as { slug?: string } | null)?.slug ?? null;
}

async function streamToIcecast(target: BroadcastTarget, abortSignal: AbortSignal): Promise<{ ok: boolean; error?: string; bytes: number }> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  // mark started
  await admin.from("broadcast_targets").update({ last_started_at: new Date().toISOString(), last_error: null }).eq("id", target.id);

  // Build a continuous body by chaining track URLs. We use a TransformStream
  // and stream chunks from each fetched MP3.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let bytes = 0;
  let stopped = false;

  abortSignal.addEventListener("abort", () => {
    stopped = true;
    try { writer.close(); } catch { /* ignore */ }
  });

  const slug = await radioSlug(target.radio_id);
  if (!slug) return { ok: false, error: "Radio not found", bytes: 0 };

  // Producer: keep pulling the live queue and piping each segment.
  const producer = (async () => {
    while (!stopped) {
      const queue = await fetchInternalQueue(slug);
      if (queue.length === 0) {
        // nothing to play; write 1s of silence (minimal MP3 frame trick: just wait).
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      for (const item of queue) {
        if (stopped) break;
        try {
          const r = await fetch(item.url);
          if (!r.ok || !r.body) continue;
          const reader = r.body.getReader();
          // throttle to ~real-time using duration to avoid sending too fast
          const startedAt = Date.now();
          let written = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (stopped) { try { reader.cancel(); } catch { /* ignore */ } break; }
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            bytes += value.byteLength;
            written += value.byteLength;
            // pacing
            const expectedMs = (written / (target.bitrate_kbps * 125)) * 1000;
            const elapsed = Date.now() - startedAt;
            if (expectedMs > elapsed) {
              await new Promise((res) => setTimeout(res, Math.min(500, expectedMs - elapsed)));
            }
          }
        } catch { /* skip segment on error */ }
      }
    }
  })();

  // Consumer: open the PUT request to Icecast with the readable stream as body.
  try {
    const url = targetUrl(target);
    const ctrl = new AbortController();
    abortSignal.addEventListener("abort", () => ctrl.abort());
    const resp = await fetch(url, {
      method: "PUT",
      signal: ctrl.signal,
      // deno-lint-ignore no-explicit-any
      body: readable as any,
      headers: {
        "Authorization": authHeader(target),
        "Content-Type": "audio/mpeg",
        "Ice-Public": "1",
        "Ice-Name": target.name,
        "Ice-Bitrate": String(target.bitrate_kbps),
        "Expect": "100-continue",
      },
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      const msg = `Icecast HTTP ${resp.status}: ${txt.slice(0, 200)}`;
      await admin.from("broadcast_targets").update({ last_error: msg }).eq("id", target.id);
      stopped = true;
      try { await writer.close(); } catch { /* ignore */ }
      return { ok: false, error: msg, bytes };
    }
    await producer;
    return { ok: true, bytes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("broadcast_targets").update({ last_error: msg }).eq("id", target.id);
    return { ok: false, error: msg, bytes };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const path = url.pathname.split("/").pop();

  try {
    const ctx = await authClient(req);
    if (!ctx) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    if (path === "test") {
      const { targetId } = await req.json();
      const t = await loadTarget(targetId, ctx.userId);
      if (!t) return new Response(JSON.stringify({ error: "Target not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      // Send a tiny PUT with empty body just to test credentials handshake.
      try {
        const r = await fetch(targetUrl(t), {
          method: "PUT",
          body: new Uint8Array(0),
          headers: {
            "Authorization": authHeader(t),
            "Content-Type": "audio/mpeg",
          },
        });
        const txt = await r.text().catch(() => "");
        return new Response(JSON.stringify({ ok: r.status >= 200 && r.status < 500, status: r.status, body: txt.slice(0, 300) }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (path === "start") {
      const { targetId } = await req.json();
      const t = await loadTarget(targetId, ctx.userId);
      if (!t) return new Response(JSON.stringify({ error: "Target not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const ctrl = new AbortController();
      req.signal.addEventListener("abort", () => ctrl.abort());
      const result = await streamToIcecast(t, ctrl.signal);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown route" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

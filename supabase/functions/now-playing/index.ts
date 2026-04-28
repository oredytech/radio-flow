// Returns currently active program(s).
// Query by ?slug=xxx OR ?radio_ids=uuid,uuid (comma-separated).
// Public endpoint — programs are publicly readable.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface Program {
  id: string;
  radio_id: string;
  type: "playlist" | "live";
  title: string | null;
  day_of_week: number;
  start_time: string;
  end_time: string;
  audio_url: string | null;
  stream_url: string | null;
}

function timeToSec(t: string): number {
  const p = t.split(":").map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

function resolveActive(progs: Program[], nowMs: number) {
  const d = new Date(nowMs);
  const dow = d.getUTCDay();
  const sec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  const todays = progs.filter((p) => p.day_of_week === dow);
  let live: Program | null = null;
  let playlist: Program | null = null;
  for (const p of todays) {
    const s = timeToSec(p.start_time);
    const e = timeToSec(p.end_time);
    if (sec >= s && sec < e) {
      if (p.type === "live") live = p;
      else playlist = p;
    }
  }
  return live ?? playlist;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");
    const radioIdsParam = url.searchParams.get("radio_ids");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    let radioIds: string[] = [];
    const radioMeta: Record<string, { id: string; slug: string; name: string }> = {};

    if (slug) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/radios?slug=eq.${encodeURIComponent(slug)}&select=id,slug,name`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      const arr = await r.json();
      if (!arr.length) {
        return new Response(JSON.stringify({ error: "Radio not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      radioIds = [arr[0].id];
      radioMeta[arr[0].id] = arr[0];
    } else if (radioIdsParam) {
      radioIds = radioIdsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
      if (radioIds.length) {
        const inList = radioIds.map((id) => `"${id}"`).join(",");
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/radios?id=in.(${inList})&select=id,slug,name`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        );
        const arr = await r.json();
        for (const row of arr) radioMeta[row.id] = row;
      }
    } else {
      return new Response(JSON.stringify({ error: "slug or radio_ids required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!radioIds.length) {
      return new Response(JSON.stringify({ server_timestamp: Date.now(), items: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    const inList = radioIds.map((id) => `"${id}"`).join(",");
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/programs?radio_id=in.(${inList})&select=*`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const programs: Program[] = await r.json();

    const now = Date.now();
    const items = radioIds.map((rid) => {
      const progs = programs.filter((p) => p.radio_id === rid);
      const active = resolveActive(progs, now);
      return {
        radio_id: rid,
        radio: radioMeta[rid] ?? null,
        active: active
          ? {
              id: active.id,
              type: active.type,
              title: active.title,
              start_time: active.start_time,
              end_time: active.end_time,
            }
          : null,
      };
    });

    return new Response(
      JSON.stringify({ server_timestamp: now, items }),
      { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

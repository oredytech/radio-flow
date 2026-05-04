// Continuous 24/7 stream playlist generator per radio.
// Public endpoint. Generates HLS (.m3u8), PLS (.pls) and M3U (.m3u) playlists
// that chain together the audio that should be playing right now (active
// scheduled program tracks → Auto DJ rotation → fallback) so external players
// (VLC, hls.js, browsers, mobile players) can listen without ever opening the
// web app. The playlist is regenerated on every fetch so the client picks up
// schedule changes by reloading (which HLS/PLS players do natively).
//
// Routes (path-based for clean shareable URLs):
//   GET /stream/<slug>.m3u8   → HLS playlist
//   GET /stream/<slug>.pls    → PLS playlist (VLC, classic players)
//   GET /stream/<slug>.m3u    → M3U playlist
//   GET /stream/<slug>.json   → JSON queue (debug)
// Fallback (when path-based isn't matched, e.g. local invoke):
//   GET /stream?slug=<slug>&format=m3u8|pls|m3u|json
//
// Public radios = no auth.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Expose-Headers": "content-length, content-range",
};

const JINGLE_MAX_SEC = 600;
const QUEUE_TARGET_SEC = 600; // build at least 10 minutes ahead
const MAX_QUEUE_ITEMS = 60;

interface Program {
  id: string;
  radio_id: string;
  type: "playlist" | "live" | "jingle";
  title: string | null;
  day_of_week: number;
  start_time: string;
  end_time: string;
  audio_url: string | null;
  stream_url: string | null;
}

interface Track {
  id: string;
  radio_id: string;
  folder_id: string | null;
  title: string;
  audio_url: string;
  duration_seconds: number | null;
  position: number;
  created_at: string;
}

interface Folder {
  id: string;
  radio_id: string;
  is_autodj_source: boolean;
  kind: string;
}

interface ProgramTrack {
  id: string;
  program_id: string;
  track_id: string;
  position: number;
  created_at: string;
}

interface QueueItem {
  url: string;
  title: string;
  durationSec: number;
  source: "program" | "autodj" | "live" | "silence";
}

function timeToSec(t: string): number {
  const p = t.split(":").map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

function resolveActive(progs: Program[], dow: number, sec: number) {
  const todays = progs.filter((p) => p.day_of_week === dow);
  let live: Program | null = null;
  let playlist: Program | null = null;
  let jingle: Program | null = null;
  for (const p of todays) {
    const s = timeToSec(p.start_time);
    const e = timeToSec(p.end_time);
    if (sec >= s && sec < e) {
      if (p.type === "jingle") {
        if (sec - s < JINGLE_MAX_SEC) jingle = p;
      } else if (p.type === "live") live = p;
      else playlist = p;
    }
  }
  return jingle ?? live ?? playlist;
}

/** Returns the next transition (in seconds since midnight) for `dow`. */
function nextTransition(progs: Program[], dow: number, sec: number): number {
  const cuts = new Set<number>();
  for (const p of progs.filter((x) => x.day_of_week === dow)) {
    const s = timeToSec(p.start_time);
    const e = timeToSec(p.end_time);
    if (s > sec) cuts.add(s);
    if (e > sec) cuts.add(e);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  return sorted.length ? sorted[0] : 86400;
}

function programTracksFor(programId: string, all: ProgramTrack[], tracks: Track[]) {
  return all
    .filter((pt) => pt.program_id === programId)
    .map((pt) => ({ pt, track: tracks.find((t) => t.id === pt.track_id) }))
    .filter((x): x is { pt: ProgramTrack; track: Track } => !!x.track && (x.track.duration_seconds ?? 0) > 0)
    .sort((a, b) => a.pt.position - b.pt.position || a.pt.created_at.localeCompare(b.pt.created_at));
}

function autoDjPool(tracks: Track[], folders: Folder[]) {
  const src = folders.find((f) => f.is_autodj_source);
  const pool = src ? tracks.filter((t) => t.folder_id === src.id) : tracks;
  return pool
    .filter((t) => (t.duration_seconds ?? 0) > 0)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

/** Build the upcoming queue starting at wall clock `nowMs`. */
function buildQueue(
  programs: Program[],
  tracks: Track[],
  folders: Folder[],
  programTracks: ProgramTrack[],
  nowMs: number,
): QueueItem[] {
  const queue: QueueItem[] = [];
  const startMs = nowMs;
  let cursorMs = startMs;
  const horizonMs = startMs + QUEUE_TARGET_SEC * 1000;

  const dj = autoDjPool(tracks, folders);
  const djTotal = dj.reduce((s, t) => s + (t.duration_seconds ?? 0), 0);

  // Helper to compute current Auto DJ position at a given wall clock.
  function djCursorAt(ms: number): { idx: number; offsetSec: number } | null {
    if (!dj.length || djTotal <= 0) return null;
    const epochSec = Math.floor(ms / 1000) % Math.floor(djTotal);
    let acc = 0;
    for (let i = 0; i < dj.length; i++) {
      const dur = dj[i].duration_seconds ?? 0;
      if (epochSec < acc + dur) return { idx: i, offsetSec: epochSec - acc };
      acc += dur;
    }
    return { idx: 0, offsetSec: 0 };
  }

  let safety = 0;
  while (cursorMs < horizonMs && queue.length < MAX_QUEUE_ITEMS && safety++ < 200) {
    const d = new Date(cursorMs);
    const dow = d.getUTCDay();
    const sec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    const active = resolveActive(programs, dow, sec);
    const nextCutSec = nextTransition(programs, dow, sec);
    const msUntilCut = (nextCutSec - sec) * 1000;
    const segmentEndMs = cursorMs + msUntilCut;

    if (active && active.type === "live") {
      // Live = external stream, can't be inserted in the playlist as a finite
      // segment. Insert a single "live" entry pointing at its stream_url and
      // jump past the program. Most players will follow the URL.
      if (active.stream_url) {
        queue.push({
          url: active.stream_url,
          title: active.title || "Direct",
          // Use program duration so the player knows when to come back.
          durationSec: Math.max(1, msUntilCut / 1000),
          source: "live",
        });
      }
      cursorMs = segmentEndMs;
      continue;
    }

    if (active && (active.type === "playlist" || active.type === "jingle")) {
      const ordered = programTracksFor(active.id, programTracks, tracks);
      const total = ordered.reduce((s, x) => s + (x.track.duration_seconds ?? 0), 0);
      if (ordered.length === 0 && active.audio_url) {
        // Legacy single-file mode.
        queue.push({
          url: active.audio_url,
          title: active.title || "Programme",
          durationSec: Math.max(1, msUntilCut / 1000),
          source: "program",
        });
        cursorMs = segmentEndMs;
        continue;
      }
      if (ordered.length === 0 || total <= 0) {
        // Nothing playable — fall through to Auto DJ for this slot below.
      } else {
        // Where in the program are we? No looping: once all tracks played,
        // we let Auto DJ take over the remainder of the slot.
        const programStartSec = timeToSec(active.start_time);
        const elapsedSec = sec - programStartSec;
        let inProg = elapsedSec; // no modulo — we want one-shot playback
        let segLeftMs = msUntilCut;
        let consumedAll = inProg >= total;
        while (segLeftMs > 0 && !consumedAll && queue.length < MAX_QUEUE_ITEMS) {
          let acc = 0;
          let chosen: { track: Track; offsetSec: number } | null = null;
          for (const x of ordered) {
            const dur = x.track.duration_seconds ?? 0;
            if (inProg < acc + dur) {
              chosen = { track: x.track, offsetSec: inProg - acc };
              break;
            }
            acc += dur;
          }
          if (!chosen) { consumedAll = true; break; }
          const remainInTrack = (chosen.track.duration_seconds ?? 0) - chosen.offsetSec;
          const dur = Math.max(1, Math.min(remainInTrack, segLeftMs / 1000));
          queue.push({
            url: chosen.track.audio_url,
            title: `${active.title || "Programme"} — ${chosen.track.title}`,
            durationSec: dur,
            source: "program",
          });
          segLeftMs -= dur * 1000;
          cursorMs += dur * 1000;
          inProg += dur;
          if (inProg >= total) consumedAll = true;
          if (cursorMs >= horizonMs) break;
        }
        // If program tracks are all consumed but there's still slot time left,
        // fall through to Auto DJ for the rest of the slot.
        if (!consumedAll || cursorMs >= segmentEndMs) {
          cursorMs = Math.max(cursorMs, segmentEndMs);
          continue;
        }
        // else: drop into Auto DJ branch below for remaining time.
      }
    }

    // No active program (or active program ran out) → Auto DJ until next transition.
    const segLimitMs = Math.min(segmentEndMs, horizonMs);
    let djCur = djCursorAt(cursorMs);
    if (!djCur) {
      // Empty Auto DJ → 30s of silence-equivalent (advance time, no entry).
      cursorMs += 30_000;
      continue;
    }
    while (cursorMs < segLimitMs && queue.length < MAX_QUEUE_ITEMS) {
      const t = dj[djCur.idx];
      const remain = (t.duration_seconds ?? 0) - djCur.offsetSec;
      if (remain <= 0) {
        djCur = { idx: (djCur.idx + 1) % dj.length, offsetSec: 0 };
        continue;
      }
      const playable = Math.min(remain, (segLimitMs - cursorMs) / 1000);
      queue.push({
        url: t.audio_url,
        title: t.title,
        durationSec: Math.max(1, playable),
        source: "autodj",
      });
      cursorMs += playable * 1000;
      djCur = { idx: (djCur.idx + 1) % dj.length, offsetSec: 0 };
    }
  }

  return queue;
}

function buildM3U8(queue: QueueItem[], radioName: string): string {
  // HLS Media Playlist — VOD-style sliding window. Players will reload it.
  const targetDur = Math.max(
    10,
    Math.ceil(queue.reduce((m, q) => Math.max(m, q.durationSec), 0)),
  );
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDur}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}`,
    `# Radio: ${radioName}`,
  ];
  for (const item of queue) {
    lines.push(`#EXTINF:${item.durationSec.toFixed(3)},${item.title.replace(/[\\r\\n,]/g, " ")}`);
    lines.push(item.url);
  }
  // Don't emit ENDLIST — the playlist is "live", players keep reloading.
  return lines.join("\n") + "\n";
}

function buildPLS(queue: QueueItem[], radioName: string): string {
  const lines = ["[playlist]", `NumberOfEntries=${queue.length}`];
  queue.forEach((q, i) => {
    const n = i + 1;
    lines.push(`File${n}=${q.url}`);
    lines.push(`Title${n}=${radioName} — ${q.title.replace(/[\\r\\n]/g, " ")}`);
    lines.push(`Length${n}=${Math.max(1, Math.round(q.durationSec))}`);
  });
  lines.push("Version=2");
  return lines.join("\n") + "\n";
}

function buildM3U(queue: QueueItem[], radioName: string): string {
  const lines = ["#EXTM3U", `# ${radioName}`];
  for (const q of queue) {
    lines.push(`#EXTINF:${Math.max(1, Math.round(q.durationSec))},${radioName} — ${q.title.replace(/[\\r\\n,]/g, " ")}`);
    lines.push(q.url);
  }
  return lines.join("\n") + "\n";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    // Path-based: /stream/<slug>.<ext>  (also tolerate any prefix the runtime adds)
    let slug: string | null = null;
    let format: "m3u8" | "pls" | "m3u" | "json" = "m3u8";

    const m = url.pathname.match(/([^/]+)\.(m3u8|pls|m3u|json)$/i);
    if (m) {
      slug = decodeURIComponent(m[1]);
      format = m[2].toLowerCase() as typeof format;
    } else {
      slug = url.searchParams.get("slug");
      const f = (url.searchParams.get("format") || "m3u8").toLowerCase();
      if (["m3u8", "pls", "m3u", "json"].includes(f)) format = f as typeof format;
    }

    if (!slug) {
      return new Response(JSON.stringify({ error: "slug required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    const radioRes = await fetch(
      `${SUPABASE_URL}/rest/v1/radios?slug=eq.${encodeURIComponent(slug)}&select=id,slug,name`,
      { headers: auth },
    );
    const radios = await radioRes.json();
    if (!radios.length) {
      return new Response(JSON.stringify({ error: "Radio not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const radio = radios[0];

    const [progs, tracks, folders, ptracks] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/programs?radio_id=eq.${radio.id}&select=*`, { headers: auth }).then((r) => r.json()),
      fetch(`${SUPABASE_URL}/rest/v1/tracks?radio_id=eq.${radio.id}&select=*`, { headers: auth }).then((r) => r.json()),
      fetch(`${SUPABASE_URL}/rest/v1/track_folders?radio_id=eq.${radio.id}&select=*`, { headers: auth }).then((r) => r.json()),
      fetch(
        `${SUPABASE_URL}/rest/v1/program_tracks?select=*,program:programs!inner(radio_id)&program.radio_id=eq.${radio.id}`,
        { headers: auth },
      ).then((r) => r.json()),
    ]);

    const queue = buildQueue(
      progs as Program[],
      tracks as Track[],
      folders as Folder[],
      (ptracks as Array<ProgramTrack & { program?: unknown }>).map(({ program: _p, ...rest }) => rest),
      Date.now(),
    );

    if (format === "json") {
      return new Response(
        JSON.stringify({ radio, generated_at: new Date().toISOString(), queue }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    if (format === "pls") {
      return new Response(buildPLS(queue, radio.name), {
        headers: { ...corsHeaders, "Content-Type": "audio/x-scpls", "Cache-Control": "no-store" },
      });
    }

    if (format === "m3u") {
      return new Response(buildM3U(queue, radio.name), {
        headers: { ...corsHeaders, "Content-Type": "audio/x-mpegurl", "Cache-Control": "no-store" },
      });
    }

    // m3u8 (default)
    return new Response(buildM3U8(queue, radio.name), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { startTimeSync, serverNow, syncServerTime } from "@/lib/time";
import {
  resolveActiveProgram,
  type Program,
  type ProgramTrack,
  type ResolvedState,
  type Track,
  type TrackFolder,
} from "@/lib/schedule";

const DRIFT_TOLERANCE_SEC = 1.2;
const RESYNC_INTERVAL_MS = 1000;
const NEAR_END_GUARD_SEC = 1.4;
const DEFAULT_FADE_MS = 1500;
const FADE_STORAGE_KEY = "ir.engine.fadeMs";

function getStoredFadeMs(): number {
  try {
    const raw = localStorage.getItem(FADE_STORAGE_KEY);
    if (!raw) return DEFAULT_FADE_MS;
    const n = parseInt(raw, 10);
    if (!isFinite(n) || n < 100 || n > 8000) return DEFAULT_FADE_MS;
    return n;
  } catch { return DEFAULT_FADE_MS; }
}

export interface EngineState extends ResolvedState {
  isPlaying: boolean;
  isReady: boolean;
  error: string | null;
  driftCorrectionSec: number;
  // What is currently being broadcast to the listener.
  // "program" = a scheduled program, "autodj" = fallback rotation, "silence" = nothing.
  source: "program" | "autodj" | "silence";
  // Title shown in the UI ("Lecture en cours" / track title / live program title)
  currentTitle: string | null;
  // ID of the track currently playing (for highlighting in the library), null if live/silence
  currentTrackId: string | null;
}

function fade(audio: HTMLAudioElement, to: number, ms: number) {
  const from = audio.volume;
  const start = performance.now();
  return new Promise<void>((resolve) => {
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      audio.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/**
 * Spawn a Web Worker that fires "tick" messages on a steady cadence.
 * This is the secret sauce for keeping the AutoDJ alive when the tab is
 * backgrounded or the device screen sleeps — `setInterval` in the main
 * thread gets throttled to ~1Hz (or worse) by browsers, but workers keep
 * running. The MediaSession + an actively playing <audio> element keep
 * the page from being fully suspended on mobile.
 */
function createTickerWorker(intervalMs: number): Worker {
  const src = `let id=null;onmessage=(e)=>{if(e.data==='start'){if(id)clearInterval(id);id=setInterval(()=>postMessage('tick'),${intervalMs});}else if(e.data==='stop'){if(id){clearInterval(id);id=null;}}};`;
  const blob = new Blob([src], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

function waitForAudioReady(audio: HTMLAudioElement, timeoutMs = 7000) {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onErr);
      clearTimeout(timer);
    };
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      fn();
    };
    const onReady = () => finish(resolve);
    const onErr = () => finish(() => reject(new Error("audio load failed")));
    const timer = window.setTimeout(() => finish(resolve), timeoutMs);
    audio.addEventListener("loadedmetadata", onReady);
    audio.addEventListener("canplay", onReady);
    audio.addEventListener("error", onErr);
    audio.load();
  });
}

function nativeEnded(audio: HTMLAudioElement, knownDuration?: number | null) {
  const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (knownDuration ?? null);
  return audio.ended || (!!dur && audio.currentTime >= Math.max(0, dur - NEAR_END_GUARD_SEC));
}

// Identifier for what is currently loaded into the playlist audio element.
// Format: "prog:<id>" | "track:<id>" | null
type CurrentSourceKey = string | null;

export function useRadioEngine(slug: string) {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [folders, setFolders] = useState<TrackFolder[]>([]);
  const [programTracks, setProgramTracks] = useState<ProgramTrack[]>([]);
  const [state, setState] = useState<EngineState>({
    active: null,
    offsetSec: 0,
    msUntilChange: 60000,
    autoDj: null,
    scheduledAudio: null,
    isPlaying: false,
    isReady: false,
    error: null,
    driftCorrectionSec: 0,
    source: "silence",
    currentTitle: null,
  });
  const [userStarted, setUserStarted] = useState(false);
  const [fadeMs, setFadeMsState] = useState<number>(() => getStoredFadeMs());

  const playlistRef = useRef<HTMLAudioElement | null>(null);
  const liveRef = useRef<HTMLAudioElement | null>(null);
  const currentKey = useRef<CurrentSourceKey>(null);
  const tickingRef = useRef(false);
  const tickFnRef = useRef<() => Promise<void>>();
  const fadeMsRef = useRef<number>(fadeMs);
  useEffect(() => { fadeMsRef.current = fadeMs; }, [fadeMs]);

  const setFadeMs = useCallback((ms: number) => {
    const clamped = Math.max(100, Math.min(8000, Math.round(ms)));
    setFadeMsState(clamped);
    try { localStorage.setItem(FADE_STORAGE_KEY, String(clamped)); } catch { /* ignore */ }
  }, []);

  // Lazy create audio elements
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    a.crossOrigin = "anonymous";
    a.volume = 0;
    // No native loop — we drive transitions via tick(); but ended must trigger
    // an immediate re-evaluation to avoid silence when the tab is backgrounded.
    a.addEventListener("ended", () => {
      // currentKey reset so tick() reloads the next track from scratch.
      currentKey.current = null;
      tickFnRef.current?.().catch(() => {});
    });
    playlistRef.current = a;
    const b = new Audio();
    b.preload = "auto";
    b.crossOrigin = "anonymous";
    b.volume = 0;
    liveRef.current = b;
    return () => {
      a.pause();
      a.src = "";
      b.pause();
      b.src = "";
    };
  }, []);

  // Load radio + programs + tracks + folders
  useEffect(() => {
    let cancelled = false;
    let cleanupFn: (() => void) | undefined;
    (async () => {
      const { data: radio, error: re } = await supabase
        .from("radios").select("id").eq("slug", slug).maybeSingle();
      if (re || !radio) {
        if (!cancelled) setState((s) => ({ ...s, error: "Radio not found" }));
        return;
      }
      const [{ data: progs }, { data: trks }, { data: flds }, { data: pts }] = await Promise.all([
        supabase.from("programs").select("*").eq("radio_id", radio.id),
        supabase.from("tracks").select("*").eq("radio_id", radio.id),
        supabase.from("track_folders").select("*").eq("radio_id", radio.id),
        supabase.from("program_tracks").select("*, track:tracks(*)").order("position"),
      ]);
      if (!cancelled) {
        setPrograms(progs ?? []);
        setTracks(trks ?? []);
        setFolders(flds ?? []);
        setProgramTracks((pts ?? []).filter((pt) => pt.track?.radio_id === radio.id) as ProgramTrack[]);
        setState((s) => ({ ...s, isReady: true }));
      }
      const channel = supabase
        .channel(`radio:${radio.id}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "programs", filter: `radio_id=eq.${radio.id}` },
          async () => {
            const { data: p2 } = await supabase
              .from("programs").select("*").eq("radio_id", radio.id);
            if (!cancelled) setPrograms(p2 ?? []);
          })
        .on("postgres_changes",
          { event: "*", schema: "public", table: "tracks", filter: `radio_id=eq.${radio.id}` },
          async () => {
            const { data: t2 } = await supabase
              .from("tracks").select("*").eq("radio_id", radio.id);
            if (!cancelled) setTracks(t2 ?? []);
          })
        .on("postgres_changes",
          { event: "*", schema: "public", table: "track_folders", filter: `radio_id=eq.${radio.id}` },
          async () => {
            const { data: f2 } = await supabase
              .from("track_folders").select("*").eq("radio_id", radio.id);
            if (!cancelled) setFolders(f2 ?? []);
          })
        .on("postgres_changes",
          { event: "*", schema: "public", table: "program_tracks" },
          async () => {
            const { data: pt2 } = await supabase
              .from("program_tracks").select("*, track:tracks(*)").order("position");
            if (!cancelled) setProgramTracks((pt2 ?? []).filter((pt) => pt.track?.radio_id === radio.id) as ProgramTrack[]);
          })
        .subscribe();
      cleanupFn = () => { supabase.removeChannel(channel); };
    })();
    return () => { cancelled = true; cleanupFn?.(); };
  }, [slug]);

  useEffect(() => { startTimeSync(30000); }, []);

  // Switch / sync logic
  const tick = useCallback(async () => {
    if (!userStarted) return;
    if (tickingRef.current) return; // re-entry guard
    tickingRef.current = true;
    try {
      const playlistAudio = playlistRef.current!;
      const liveAudio = liveRef.current!;

      const now = serverNow();
      const resolved = resolveActiveProgram(programs, now, tracks, folders, programTracks);
      const { active, offsetSec, autoDj, scheduledAudio } = resolved;

      let driftCorrection = 0;

      // ---- 1. LIVE program -------------------------------------------------
      if (active && active.type === "live") {
        const key = `prog:${active.id}`;
        if (currentKey.current !== key) {
          if (!playlistAudio.paused) {
            await fade(playlistAudio, 0, fadeMsRef.current);
            playlistAudio.pause();
          }
          liveAudio.src = active.stream_url ?? "";
          liveAudio.volume = 0;
          try {
            await liveAudio.play();
            await fade(liveAudio, 1, fadeMsRef.current);
            currentKey.current = key;
          } catch (err) {
            console.warn("[engine] live stream failed", err);
            setState((s) => ({ ...s, error: "Flux direct indisponible", source: "silence", currentTitle: null }));
            return;
          }
        }
        setState({
          ...resolved,
          isPlaying: true,
          isReady: true,
          error: null,
          driftCorrectionSec: 0,
          source: "program",
          currentTitle: active.title || "Émission en direct",
        });
        return;
      }

      // ---- 2. Playlist or Jingle program (file-based) ---------------------
      // If active program exists AND scheduledAudio is available, play it.
      // If scheduledAudio is null, the program's tracks have all been played:
      // fall through to Auto DJ for the remainder of the slot.
      if (active && (active.type === "playlist" || active.type === "jingle") && scheduledAudio) {
        const key = scheduledAudio.key;
        const audioUrl = scheduledAudio.audioUrl;
        const switched = currentKey.current !== key;

        if (!liveAudio.paused) {
          await fade(liveAudio, 0, fadeMsRef.current);
          liveAudio.pause();
        }

        if (switched) {
          try {
            playlistAudio.src = audioUrl;
            playlistAudio.volume = 0;
            await waitForAudioReady(playlistAudio);
            const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
              ? playlistAudio.duration : scheduledAudio.durationSec;
            const target = active.type === "jingle"
              ? Math.min(scheduledAudio.offsetSec, dur ?? scheduledAudio.offsetSec)
              : scheduledAudio.offsetSec;
            playlistAudio.currentTime = Math.max(0, target);
            await playlistAudio.play();
            await fade(playlistAudio, 1, fadeMsRef.current);
            currentKey.current = key;
          } catch (err) {
            console.warn("[engine] playlist load failed", err);
            setState((s) => ({ ...s, error: "Audio indisponible", source: "silence", currentTitle: null }));
            currentKey.current = null;
            return;
          }
        } else if (active.type === "playlist") {
          const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
            ? playlistAudio.duration : scheduledAudio.durationSec;
          if (nativeEnded(playlistAudio, dur)) {
            currentKey.current = null;
            window.setTimeout(() => tickFnRef.current?.().catch(() => {}), 0);
            return;
          }
          const target = scheduledAudio.offsetSec;
          const diff = target - playlistAudio.currentTime;
          if (Math.abs(diff) > DRIFT_TOLERANCE_SEC) {
            playlistAudio.currentTime = Math.max(0, target);
            driftCorrection = diff;
          }
        }

        setState({
          ...resolved,
          isPlaying: true,
          isReady: true,
          error: null,
          driftCorrectionSec: driftCorrection,
          source: "program",
          currentTitle: active.title || scheduledAudio.title || (active.type === "jingle" ? "Jingle" : "Lecture en cours"),
        });
        return;
      }

      // ---- 3. Auto DJ fallback --------------------------------------------
      if (autoDj && autoDj.track) {
        const track = autoDj.track;
        const key = `track:${track.id}`;
        if (!liveAudio.paused) {
          await fade(liveAudio, 0, fadeMsRef.current);
          liveAudio.pause();
        }
        const switched = currentKey.current !== key;
        if (switched) {
          try {
            playlistAudio.src = track.audio_url;
            playlistAudio.volume = 0;
            await waitForAudioReady(playlistAudio);
            const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
              ? playlistAudio.duration : (track.duration_seconds ?? 0);
            const target = dur > 0 ? Math.min(autoDj.offsetSec, dur - 0.1) : 0;
            playlistAudio.currentTime = Math.max(0, target);
            await playlistAudio.play();
            await fade(playlistAudio, 1, fadeMsRef.current);
            currentKey.current = key;
          } catch (err) {
            console.warn("[engine] autodj load failed", err);
            setState((s) => ({ ...s, error: "Auto DJ indisponible", source: "silence", currentTitle: null }));
            currentKey.current = null;
            return;
          }
        } else {
          const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
            ? playlistAudio.duration : null;
          if (nativeEnded(playlistAudio, dur ?? track.duration_seconds)) {
            currentKey.current = null;
            window.setTimeout(() => tickFnRef.current?.().catch(() => {}), 0);
            return;
          }
          // If the audio element has stopped (e.g. paused by OS) restart it.
          if (playlistAudio.paused) {
            try { await playlistAudio.play(); } catch { /* needs gesture */ }
          }
          const target = dur ? autoDj.offsetSec : autoDj.offsetSec;
          const diff = target - playlistAudio.currentTime;
          if (Math.abs(diff) > DRIFT_TOLERANCE_SEC) {
            playlistAudio.currentTime = Math.max(0, target);
            driftCorrection = diff;
          }
        }

        setState({
          ...resolved,
          isPlaying: true,
          isReady: true,
          error: null,
          driftCorrectionSec: driftCorrection,
          source: "autodj",
          currentTitle: track.title,
        });
        return;
      }

      // ---- 4. True silence -------------------------------------------------
      if (!playlistAudio.paused) await fade(playlistAudio, 0, fadeMsRef.current).then(() => playlistAudio.pause());
      if (!liveAudio.paused) await fade(liveAudio, 0, fadeMsRef.current).then(() => liveAudio.pause());
      currentKey.current = null;
      setState({
        ...resolved,
        isPlaying: false,
        isReady: true,
        error: null,
        driftCorrectionSec: 0,
        source: "silence",
        currentTitle: null,
      });
    } finally {
      tickingRef.current = false;
    }
  }, [programs, tracks, folders, programTracks, userStarted]);

  // Keep latest tick fn in a ref so the audio "ended" listener can call it.
  useEffect(() => { tickFnRef.current = tick; }, [tick]);

  // Web Worker ticker — survives tab backgrounding / screen sleep.
  useEffect(() => {
    if (!userStarted) return;
    tick();
    const worker = createTickerWorker(RESYNC_INTERVAL_MS);
    worker.onmessage = () => { tickFnRef.current?.().catch(() => {}); };
    worker.postMessage("start");

    // Re-tick instantly when tab becomes visible again (snap any drift).
    const onVis = () => {
      if (document.visibilityState === "visible") tickFnRef.current?.().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      worker.postMessage("stop");
      worker.terminate();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [userStarted, tick]);

  // MediaSession — tells the OS this page is playing audio so it isn't
  // suspended. Required for Android Chrome / iOS Safari background audio.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!state.currentTitle) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.currentTitle,
        artist: slug,
        album: "Radio",
      });
      navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
    } catch { /* ignore */ }
  }, [state.currentTitle, state.isPlaying, slug]);

  // Light heartbeat for the UI clock even before the user starts playback
  const [, setHeartbeat] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setHeartbeat((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (programs.length === 0 && tracks.length === 0) return;
    const now = serverNow();
    const resolved = resolveActiveProgram(programs, now, tracks, folders, programTracks);
    setState((s) => ({ ...s, ...resolved }));
  }, [programs, tracks, folders, programTracks]);

  const start = useCallback(async () => {
    await syncServerTime();
    setUserStarted(true);
  }, []);

  const stop = useCallback(() => {
    playlistRef.current?.pause();
    liveRef.current?.pause();
    setUserStarted(false);
    currentKey.current = null;
    setState((s) => ({ ...s, isPlaying: false, source: "silence" }));
  }, []);

  return { state, programs, tracks, folders, start, stop, userStarted, fadeMs, setFadeMs };
}

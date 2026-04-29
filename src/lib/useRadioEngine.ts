import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { startTimeSync, serverNow, syncServerTime } from "@/lib/time";
import {
  resolveActiveProgram,
  type Program,
  type ResolvedState,
  type Track,
} from "@/lib/schedule";

const DRIFT_TOLERANCE_SEC = 1.2;
const RESYNC_INTERVAL_MS = 4000;
const FADE_MS = 600;

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

// Identifier for what is currently loaded into the playlist audio element.
// Format: "prog:<id>" | "track:<id>" | null
type CurrentSourceKey = string | null;

export function useRadioEngine(slug: string) {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [state, setState] = useState<EngineState>({
    active: null,
    offsetSec: 0,
    msUntilChange: 60000,
    autoDj: null,
    isPlaying: false,
    isReady: false,
    error: null,
    driftCorrectionSec: 0,
    source: "silence",
    currentTitle: null,
  });
  const [userStarted, setUserStarted] = useState(false);

  const playlistRef = useRef<HTMLAudioElement | null>(null);
  const liveRef = useRef<HTMLAudioElement | null>(null);
  const currentKey = useRef<CurrentSourceKey>(null);

  // Lazy create audio elements
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    a.crossOrigin = "anonymous";
    a.volume = 0;
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

  // Load radio + programs + tracks
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
      const [{ data: progs }, { data: trks }] = await Promise.all([
        supabase.from("programs").select("*").eq("radio_id", radio.id),
        supabase.from("tracks").select("*").eq("radio_id", radio.id),
      ]);
      if (!cancelled) {
        setPrograms(progs ?? []);
        setTracks(trks ?? []);
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
        .subscribe();
      cleanupFn = () => { supabase.removeChannel(channel); };
    })();
    return () => { cancelled = true; cleanupFn?.(); };
  }, [slug]);

  useEffect(() => { startTimeSync(30000); }, []);

  // Switch / sync logic
  const tick = useCallback(async () => {
    if (!userStarted) return;
    const playlistAudio = playlistRef.current!;
    const liveAudio = liveRef.current!;

    const now = serverNow();
    const resolved = resolveActiveProgram(programs, now, tracks);
    const { active, offsetSec, autoDj } = resolved;

    let driftCorrection = 0;

    // ---- 1. LIVE program -------------------------------------------------
    if (active && active.type === "live") {
      const key = `prog:${active.id}`;
      if (currentKey.current !== key) {
        if (!playlistAudio.paused) {
          await fade(playlistAudio, 0, FADE_MS);
          playlistAudio.pause();
        }
        liveAudio.src = active.stream_url ?? "";
        liveAudio.volume = 0;
        try {
          await liveAudio.play();
          await fade(liveAudio, 1, FADE_MS);
          currentKey.current = key;
        } catch (err) {
          console.warn("[engine] live stream failed", err);
          setState((s) => ({ ...s, error: "Flux direct indisponible", source: "silence", currentTitle: null }));
          return;
        }
      }
      // NB: NO offset applied to live — stream is real-time
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
    if (active && (active.type === "playlist" || active.type === "jingle")) {
      const key = `prog:${active.id}`;
      const audioUrl = active.audio_url ?? "";
      const switched = currentKey.current !== key;

      if (!liveAudio.paused) {
        await fade(liveAudio, 0, FADE_MS);
        liveAudio.pause();
      }

      if (switched) {
        try {
          playlistAudio.src = audioUrl;
          playlistAudio.volume = 0;
          await new Promise<void>((res, rej) => {
            const onLoaded = () => { cleanup(); res(); };
            const onErr = () => { cleanup(); rej(new Error("audio load failed")); };
            const cleanup = () => {
              playlistAudio.removeEventListener("loadedmetadata", onLoaded);
              playlistAudio.removeEventListener("error", onErr);
            };
            playlistAudio.addEventListener("loadedmetadata", onLoaded);
            playlistAudio.addEventListener("error", onErr);
            playlistAudio.load();
          });
          const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
            ? playlistAudio.duration : null;
          // Jingle = play once from start; Playlist = loop with offset
          const target = active.type === "jingle"
            ? Math.min(offsetSec, dur ?? offsetSec)
            : (dur ? offsetSec % dur : offsetSec);
          playlistAudio.currentTime = Math.max(0, target);
          await playlistAudio.play();
          await fade(playlistAudio, 1, FADE_MS);
          currentKey.current = key;
        } catch (err) {
          console.warn("[engine] playlist load failed", err);
          setState((s) => ({ ...s, error: "Audio indisponible", source: "silence", currentTitle: null }));
          currentKey.current = null;
          return;
        }
      } else {
        // Drift correction (skip for jingles — they play through once)
        if (active.type === "playlist") {
          const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
            ? playlistAudio.duration : null;
          const target = dur ? offsetSec % dur : offsetSec;
          const diff = target - playlistAudio.currentTime;
          if (Math.abs(diff) > DRIFT_TOLERANCE_SEC) {
            playlistAudio.currentTime = Math.max(0, target);
            driftCorrection = diff;
          }
        }
      }

      setState({
        ...resolved,
        isPlaying: true,
        isReady: true,
        error: null,
        driftCorrectionSec: driftCorrection,
        source: "program",
        currentTitle: active.title || (active.type === "jingle" ? "Jingle" : "Lecture en cours"),
      });
      return;
    }

    // ---- 3. Auto DJ fallback --------------------------------------------
    if (autoDj && autoDj.track) {
      const track = autoDj.track;
      const key = `track:${track.id}`;
      if (!liveAudio.paused) {
        await fade(liveAudio, 0, FADE_MS);
        liveAudio.pause();
      }
      const switched = currentKey.current !== key;
      if (switched) {
        try {
          playlistAudio.src = track.audio_url;
          playlistAudio.volume = 0;
          await new Promise<void>((res, rej) => {
            const onLoaded = () => { cleanup(); res(); };
            const onErr = () => { cleanup(); rej(new Error("audio load failed")); };
            const cleanup = () => {
              playlistAudio.removeEventListener("loadedmetadata", onLoaded);
              playlistAudio.removeEventListener("error", onErr);
            };
            playlistAudio.addEventListener("loadedmetadata", onLoaded);
            playlistAudio.addEventListener("error", onErr);
            playlistAudio.load();
          });
          const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
            ? playlistAudio.duration : (track.duration_seconds ?? 0);
          const target = dur > 0 ? Math.min(autoDj.offsetSec, dur - 0.1) : 0;
          playlistAudio.currentTime = Math.max(0, target);
          await playlistAudio.play();
          await fade(playlistAudio, 1, FADE_MS);
          currentKey.current = key;
        } catch (err) {
          console.warn("[engine] autodj load failed", err);
          setState((s) => ({ ...s, error: "Auto DJ indisponible", source: "silence", currentTitle: null }));
          currentKey.current = null;
          return;
        }
      } else {
        // Drift correction within the current track
        const dur = isFinite(playlistAudio.duration) && playlistAudio.duration > 0
          ? playlistAudio.duration : null;
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
    if (!playlistAudio.paused) await fade(playlistAudio, 0, FADE_MS).then(() => playlistAudio.pause());
    if (!liveAudio.paused) await fade(liveAudio, 0, FADE_MS).then(() => liveAudio.pause());
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
  }, [programs, tracks, userStarted]);

  useEffect(() => {
    if (!userStarted) return;
    tick();
    const id = setInterval(tick, RESYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tick, userStarted]);

  // Light heartbeat for the UI clock even before the user starts playback
  const [, setHeartbeat] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setHeartbeat((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (programs.length === 0 && tracks.length === 0) return;
    const now = serverNow();
    const resolved = resolveActiveProgram(programs, now, tracks);
    setState((s) => ({ ...s, ...resolved }));
  }, [programs, tracks]);

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

  return { state, programs, tracks, start, stop, userStarted };
}

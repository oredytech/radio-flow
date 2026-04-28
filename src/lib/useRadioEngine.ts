import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { startTimeSync, serverNow, syncServerTime } from "@/lib/time";
import { resolveActiveProgram, type Program, type ResolvedState } from "@/lib/schedule";

const DRIFT_TOLERANCE_SEC = 1.2;
const RESYNC_INTERVAL_MS = 4000;
const FADE_MS = 600;

export interface EngineState extends ResolvedState {
  isPlaying: boolean;
  isReady: boolean;
  error: string | null;
  driftCorrectionSec: number;
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

export function useRadioEngine(slug: string) {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [state, setState] = useState<EngineState>({
    active: null,
    offsetSec: 0,
    msUntilChange: 60000,
    isPlaying: false,
    isReady: false,
    error: null,
    driftCorrectionSec: 0,
  });
  const [userStarted, setUserStarted] = useState(false);

  const playlistRef = useRef<HTMLAudioElement | null>(null);
  const liveRef = useRef<HTMLAudioElement | null>(null);
  const currentProgramId = useRef<string | null>(null);

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

  // Load radio + programs
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: radio, error: re } = await supabase
        .from("radios").select("id").eq("slug", slug).maybeSingle();
      if (re || !radio) {
        if (!cancelled) setState((s) => ({ ...s, error: "Radio not found" }));
        return;
      }
      const { data: progs } = await supabase
        .from("programs").select("*").eq("radio_id", radio.id);
      if (!cancelled) {
        setPrograms(progs ?? []);
        setState((s) => ({ ...s, isReady: true }));
      }
      // Realtime updates
      const channel = supabase
        .channel(`programs:${radio.id}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "programs", filter: `radio_id=eq.${radio.id}` },
          async () => {
            const { data: p2 } = await supabase
              .from("programs").select("*").eq("radio_id", radio.id);
            if (!cancelled) setPrograms(p2 ?? []);
          })
        .subscribe();
      return () => { supabase.removeChannel(channel); };
    })();
    return () => { cancelled = true; };
  }, [slug]);

  // Server-time sync
  useEffect(() => { startTimeSync(30000); }, []);

  // Switch / sync logic
  const tick = useCallback(async () => {
    if (!userStarted) return;
    const playlistAudio = playlistRef.current!;
    const liveAudio = liveRef.current!;

    const now = serverNow();
    const resolved = resolveActiveProgram(programs, now);
    const { active, offsetSec } = resolved;

    let driftCorrection = 0;

    if (!active) {
      // Silence
      if (!playlistAudio.paused) await fade(playlistAudio, 0, FADE_MS).then(() => playlistAudio.pause());
      if (!liveAudio.paused) await fade(liveAudio, 0, FADE_MS).then(() => liveAudio.pause());
      currentProgramId.current = null;
      setState({ ...resolved, isPlaying: false, isReady: true, error: null, driftCorrectionSec: 0 });
      return;
    }

    const switched = currentProgramId.current !== active.id;

    if (active.type === "live") {
      if (switched) {
        // Fade playlist out, swap to live
        if (!playlistAudio.paused) {
          await fade(playlistAudio, 0, FADE_MS);
          playlistAudio.pause();
        }
        liveAudio.src = active.stream_url ?? "";
        liveAudio.volume = 0;
        try {
          await liveAudio.play();
          await fade(liveAudio, 1, FADE_MS);
        } catch (err) {
          // Stream failure → fall back to silence (or playlist if exists)
          console.warn("[engine] live stream failed", err);
          setState((s) => ({ ...s, error: "Live stream unavailable" }));
        }
        currentProgramId.current = active.id;
      }
    } else {
      // playlist mode
      if (switched) {
        if (!liveAudio.paused) {
          await fade(liveAudio, 0, FADE_MS);
          liveAudio.pause();
        }
        playlistAudio.src = active.audio_url ?? "";
        playlistAudio.volume = 0;
        try {
          // Wait for metadata to know duration (for offset modulo)
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
          const target = dur ? offsetSec % dur : offsetSec;
          playlistAudio.currentTime = Math.max(0, target);
          await playlistAudio.play();
          await fade(playlistAudio, 1, FADE_MS);
          currentProgramId.current = active.id;
        } catch (err) {
          console.warn("[engine] playlist load failed", err);
          setState((s) => ({ ...s, error: "Audio unavailable" }));
          currentProgramId.current = null;
        }
      } else {
        // Drift correction
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
    });
  }, [programs, userStarted]);

  useEffect(() => {
    if (!userStarted) return;
    tick();
    const id = setInterval(tick, RESYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tick, userStarted]);

  // Light-weight clock for UI even before user starts
  const [, setHeartbeat] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setHeartbeat((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (programs.length === 0) return;
    const now = serverNow();
    const resolved = resolveActiveProgram(programs, now);
    setState((s) => ({ ...s, ...resolved }));
  }, [programs]);

  const start = useCallback(async () => {
    await syncServerTime();
    setUserStarted(true);
  }, []);

  const stop = useCallback(() => {
    playlistRef.current?.pause();
    liveRef.current?.pause();
    setUserStarted(false);
    currentProgramId.current = null;
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  return { state, programs, start, stop, userStarted };
}

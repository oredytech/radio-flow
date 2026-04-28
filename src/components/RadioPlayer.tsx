import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Play, Pause, Radio as RadioIcon } from "lucide-react";
import { useRadioEngine } from "@/lib/useRadioEngine";
import { secToHHMM, timeToSec } from "@/lib/schedule";
import { cn } from "@/lib/utils";

interface RadioPlayerProps {
  slug: string;
  radioName?: string;
  theme?: "dark" | "light";
  minimal?: boolean;
  autoplay?: boolean;
}

export function RadioPlayer({
  slug, radioName, theme = "dark", minimal = false, autoplay = false,
}: RadioPlayerProps) {
  const { state, start, stop, userStarted } = useRadioEngine(slug);
  const [autoTried, setAutoTried] = useState(false);

  useEffect(() => {
    if (autoplay && !autoTried && state.isReady) {
      setAutoTried(true);
      // Browsers often block this without gesture; we still try.
      start().catch(() => {});
    }
  }, [autoplay, autoTried, state.isReady, start]);

  const isLight = theme === "light";
  const isLive = state.active?.type === "live";

  if (state.error === "Radio not found") {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center bg-card text-muted-foreground">
        Radio introuvable
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center gap-4 overflow-hidden rounded-xl border p-4",
        isLight
          ? "bg-white text-zinc-900 border-zinc-200"
          : "bg-gradient-card text-foreground border-border shadow-elevated",
      )}
    >
      {/* Glow */}
      {!isLight && (
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ background: "radial-gradient(ellipse at 0% 0%, hsl(var(--neon-cyan)/0.15), transparent 50%)" }}
        />
      )}

      <button
        onClick={() => (userStarted ? stop() : start())}
        className={cn(
          "relative z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95",
          isLive
            ? "bg-[hsl(var(--live-red))] text-white shadow-[0_0_30px_hsl(var(--live-red)/0.6)]"
            : "bg-gradient-brand text-primary-foreground shadow-glow",
        )}
        aria-label={userStarted ? "Stop" : "Play"}
      >
        {userStarted ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6 translate-x-0.5" />}
      </button>

      <div className="relative z-10 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isLive && userStarted && (
            <span className="live-pulse inline-flex items-center gap-1 rounded-full bg-[hsl(var(--live-red))] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
              ● En direct
            </span>
          )}
          {!isLive && userStarted && state.active && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
              <span className="equalizer-bar" />
              <span className="equalizer-bar" />
              <span className="equalizer-bar" />
              <span className="ml-1">À l'antenne</span>
            </span>
          )}
          {radioName && !minimal && (
            <span className="truncate text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {radioName}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-base font-semibold">
          {state.active?.title || (state.active ? (isLive ? "Émission en direct" : "Lecture en cours") : "Hors antenne")}
        </div>
        {!minimal && state.active && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {secToHHMM(timeToSec(state.active.start_time))} – {secToHHMM(timeToSec(state.active.end_time))}
            {!isLive && userStarted && (
              <span className="ml-2 opacity-70">
                offset {Math.floor(state.offsetSec / 60)}:{(Math.floor(state.offsetSec) % 60).toString().padStart(2, "0")}
              </span>
            )}
          </div>
        )}
      </div>

      {!minimal && (
        <div className="relative z-10 hidden sm:flex flex-col items-end text-right">
          <RadioIcon className="h-5 w-5 text-primary" />
          {state.error && state.error !== "Radio not found" && (
            <span className="mt-1 text-[10px] text-destructive">{state.error}</span>
          )}
        </div>
      )}
    </div>
  );
}

// Re-export Button to avoid unused lint if needed
void Button;

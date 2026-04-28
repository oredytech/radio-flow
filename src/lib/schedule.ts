import type { Tables } from "@/integrations/supabase/types";

export type Program = Tables<"programs">;

// Parse "HH:MM:SS" or "HH:MM" → seconds since midnight
export function timeToSec(t: string): number {
  const parts = t.split(":").map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

export function secToHHMM(s: number): string {
  const h = Math.floor(s / 3600).toString().padStart(2, "0");
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export interface ResolvedState {
  active: Program | null;
  // seconds elapsed since program start (for playlist offset)
  offsetSec: number;
  // milliseconds until next program transition
  msUntilChange: number;
}

/**
 * Resolve which program should be playing at server time `nowMs`.
 * LIVE always overrides PLAYLIST when both windows match.
 */
export function resolveActiveProgram(programs: Program[], nowMs: number): ResolvedState {
  const d = new Date(nowMs);
  const dow = d.getUTCDay(); // We compare in local user time below
  // Use local time so the listener experiences the schedule on their wall clock
  const local = new Date(nowMs);
  const localDow = local.getDay();
  const localSec = local.getHours() * 3600 + local.getMinutes() * 60 + local.getSeconds();

  const todays = programs.filter((p) => p.day_of_week === localDow);

  let live: Program | null = null;
  let playlist: Program | null = null;

  for (const p of todays) {
    const s = timeToSec(p.start_time);
    const e = timeToSec(p.end_time);
    if (localSec >= s && localSec < e) {
      if (p.type === "live") live = p;
      else if (p.type === "playlist") playlist = p;
    }
  }

  const active = live ?? playlist;

  let offsetSec = 0;
  let msUntilChange = 60_000;
  if (active) {
    const s = timeToSec(active.start_time);
    const e = timeToSec(active.end_time);
    offsetSec = localSec - s;
    msUntilChange = (e - localSec) * 1000;
  } else {
    // Find next program today
    const upcoming = todays
      .map((p) => timeToSec(p.start_time))
      .filter((s) => s > localSec)
      .sort((a, b) => a - b);
    if (upcoming.length) msUntilChange = (upcoming[0] - localSec) * 1000;
    else msUntilChange = (24 * 3600 - localSec) * 1000;
  }
  void dow;

  return { active, offsetSec, msUntilChange };
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

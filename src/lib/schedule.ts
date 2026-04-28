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

export const DAY_LABELS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
export const DAY_LABELS_SHORT = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

/**
 * Return overlapping program pairs in `programs` that share the same radio_id,
 * day_of_week and type. Optionally exclude one id (the one being edited).
 */
export function findOverlaps(
  programs: Pick<Program, "id" | "radio_id" | "day_of_week" | "type" | "start_time" | "end_time">[],
  excludeId?: string,
): Array<[typeof programs[number], typeof programs[number]]> {
  const pairs: Array<[typeof programs[number], typeof programs[number]]> = [];
  const list = excludeId ? programs.filter((p) => p.id !== excludeId) : programs;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.radio_id !== b.radio_id) continue;
      if (a.day_of_week !== b.day_of_week) continue;
      if (a.type !== b.type) continue;
      const aS = timeToSec(a.start_time), aE = timeToSec(a.end_time);
      const bS = timeToSec(b.start_time), bE = timeToSec(b.end_time);
      if (aS < bE && bS < aE) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * Check if a candidate program window overlaps any existing program for the same
 * radio/day/type (excluding the candidate's own id when editing).
 */
export function overlapsExisting(
  programs: Pick<Program, "id" | "radio_id" | "day_of_week" | "type" | "start_time" | "end_time">[],
  candidate: { id?: string; radio_id: string; day_of_week: number; type: string; start_time: string; end_time: string },
): boolean {
  const cS = timeToSec(candidate.start_time);
  const cE = timeToSec(candidate.end_time);
  if (cE <= cS) return false; // invalid range, handled elsewhere
  return programs.some((p) =>
    p.id !== candidate.id &&
    p.radio_id === candidate.radio_id &&
    p.day_of_week === candidate.day_of_week &&
    p.type === candidate.type &&
    timeToSec(p.start_time) < cE &&
    timeToSec(p.end_time) > cS,
  );
}

import type { Tables } from "@/integrations/supabase/types";

export type Program = Tables<"programs">;
export type Track = Tables<"tracks">;
export type TrackFolder = Tables<"track_folders">;

export interface ProgramTrack {
  id: string;
  program_id: string;
  track_id: string;
  position: number;
  created_at: string;
  track?: Track | null;
}

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
  // seconds elapsed since program start (for playlist offset). Ignored for live.
  offsetSec: number;
  // milliseconds until next program transition
  msUntilChange: number;
  // When no scheduled program is active, the engine falls back to the Auto DJ
  // (rotating tracks library). We expose the resolved track + its offset here.
  autoDj: {
    track: Track | null;
    // seconds since the start of this track in the global rotation
    offsetSec: number;
    // index of the track in the rotation (for diagnostics)
    index: number;
  } | null;
  scheduledAudio: {
    key: string;
    audioUrl: string;
    title: string;
    offsetSec: number;
    durationSec: number | null;
    index: number;
    track: Track | null;
  } | null;
}

const JINGLE_MAX_SEC = 600; // jingles max 10 min, ponctuels

/**
 * Resolve which program should be playing at server time `nowMs`.
 * Priority order: JINGLE > LIVE > PLAYLIST > AUTO DJ.
 * Jingles take over briefly (one-shot, no overlap check). They're prioritized
 * because they're typically very short interruptions.
 */
export function resolveActiveProgram(
  programs: Program[],
  nowMs: number,
  tracks: Track[] = [],
  folders: TrackFolder[] = [],
  programTracks: ProgramTrack[] = [],
): ResolvedState {
  const local = new Date(nowMs);
  const localDow = local.getDay();
  const localSec = local.getHours() * 3600 + local.getMinutes() * 60 + local.getSeconds();

  const todays = programs.filter((p) => p.day_of_week === localDow);

  let live: Program | null = null;
  let playlist: Program | null = null;
  let jingle: Program | null = null;

  for (const p of todays) {
    const s = timeToSec(p.start_time);
    const e = timeToSec(p.end_time);
    if (localSec >= s && localSec < e) {
      if (p.type === "jingle") {
        // Only consider a jingle "active" if we're within its short window AND
        // within the first JINGLE_MAX_SEC seconds (it plays once, not in loop).
        if (localSec - s < JINGLE_MAX_SEC) jingle = p;
      } else if (p.type === "live") {
        live = p;
      } else if (p.type === "playlist") {
        playlist = p;
      }
    }
  }

  const active = jingle ?? live ?? playlist;

  let offsetSec = 0;
  let msUntilChange = 60_000;
  if (active) {
    const s = timeToSec(active.start_time);
    const e = timeToSec(active.end_time);
    offsetSec = localSec - s;
    msUntilChange = (e - localSec) * 1000;
  } else {
    const upcoming = todays
      .map((p) => timeToSec(p.start_time))
      .filter((s) => s > localSec)
      .sort((a, b) => a - b);
    if (upcoming.length) msUntilChange = (upcoming[0] - localSec) * 1000;
    else msUntilChange = (24 * 3600 - localSec) * 1000;
  }

  // Auto DJ — uses only the tracks from the folder marked is_autodj_source.
  const autoDj = computeAutoDj(tracks, nowMs, folders);
  const scheduledAudio = active && (active.type === "playlist" || active.type === "jingle")
    ? computeProgramAudio(active, offsetSec, programTracks)
    : null;

  return { active, offsetSec, msUntilChange, autoDj, scheduledAudio };
}

export function computeProgramAudio(program: Program, offsetSec: number, programTracks: ProgramTrack[] = []) {
  const ordered = programTracks
    .filter((pt) => pt.program_id === program.id && pt.track)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  if (ordered.length === 0) {
    if (!program.audio_url) return null;
    return {
      key: `program:${program.id}:legacy`,
      audioUrl: program.audio_url,
      title: program.title || (program.type === "jingle" ? "Jingle" : "Lecture en cours"),
      offsetSec,
      durationSec: null,
      index: 0,
      track: null,
    };
  }

  const playable = ordered.filter((pt) => (pt.track?.duration_seconds ?? 0) > 0);
  if (playable.length === 0) {
    const first = ordered[0].track!;
    return {
      key: `program:${program.id}:track:${first.id}`,
      audioUrl: first.audio_url,
      title: first.title,
      offsetSec: 0,
      durationSec: null,
      index: 0,
      track: first,
    };
  }

  const total = playable.reduce((sum, pt) => sum + (pt.track?.duration_seconds ?? 0), 0);
  if (total <= 0) return null;
  const cursor = program.type === "jingle" ? offsetSec : offsetSec % total;
  if (program.type === "jingle" && cursor >= total) return null;

  let acc = 0;
  for (let i = 0; i < playable.length; i++) {
    const track = playable[i].track!;
    const dur = track.duration_seconds ?? 0;
    if (cursor < acc + dur) {
      return {
        key: `program:${program.id}:track:${track.id}:${i}`,
        audioUrl: track.audio_url,
        title: track.title,
        offsetSec: cursor - acc,
        durationSec: dur,
        index: i,
        track,
      };
    }
    acc += dur;
  }
  return null;
}

/**
 * Deterministic Auto DJ: tracks from the AutoDJ-source folder ordered by
 * `position`, looped end-to-end. The position in the global rotation is
 * derived from server time so that every listener hears the exact same
 * track at the same offset.
 */
export function computeAutoDj(tracks: Track[], nowMs: number, folders: TrackFolder[] = []) {
  const sourceFolder = folders.find((f) => f.is_autodj_source);
  const pool = sourceFolder
    ? tracks.filter((t) => t.folder_id === sourceFolder.id)
    : tracks; // legacy fallback if no folder configured yet
  const music = pool
    .filter((t) => (t.duration_seconds ?? 0) > 0)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  if (music.length === 0) return { track: null, offsetSec: 0, index: 0 };

  const totalLoop = music.reduce((s, t) => s + (t.duration_seconds ?? 0), 0);
  if (totalLoop <= 0) return { track: null, offsetSec: 0, index: 0 };

  const epochSec = Math.floor(nowMs / 1000) % Math.floor(totalLoop);
  let acc = 0;
  for (let i = 0; i < music.length; i++) {
    const dur = music[i].duration_seconds ?? 0;
    if (epochSec < acc + dur) {
      return { track: music[i], offsetSec: epochSec - acc, index: i };
    }
    acc += dur;
  }
  return { track: music[0], offsetSec: 0, index: 0 };
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

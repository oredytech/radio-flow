import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { DAY_LABELS } from "@/lib/schedule";
import type { Tables } from "@/integrations/supabase/types";
import { Pencil, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Program = Tables<"programs">;

interface Props {
  programs: Program[];
  conflictIds: Set<string>;
  onEdit: (p: Program) => void;
  onDelete: (id: string) => void;
  onCreate?: (day: number, hour: number) => void;
}

// 7 days x 24 hours grid (Google-Calendar style)
export function ProgramCalendar({ programs, conflictIds, onEdit, onDelete, onCreate }: Props) {
  const HOUR_PX = 44;
  const grouped = useMemo(() => {
    const m: Record<number, Program[]> = {};
    for (const p of programs) (m[p.day_of_week] ??= []).push(p);
    return m;
  }, [programs]);

  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m || 0);
  };

  // Compute "Auto DJ" gap blocks per day = inverse of all programmed intervals.
  // The engine already falls back to Auto DJ on these gaps; here we surface it
  // visually so the operator sees the radio is always on the air.
  const autoDjGaps = useMemo(() => {
    const out: Record<number, Array<{ startMin: number; endMin: number }>> = {};
    for (let d = 0; d < 7; d++) {
      const intervals = (grouped[d] ?? [])
        .map((p) => ({ s: toMin(p.start_time), e: toMin(p.end_time) }))
        .sort((a, b) => a.s - b.s);
      const gaps: Array<{ startMin: number; endMin: number }> = [];
      let cursor = 0;
      for (const it of intervals) {
        if (it.s > cursor) gaps.push({ startMin: cursor, endMin: it.s });
        if (it.e > cursor) cursor = it.e;
      }
      if (cursor < 24 * 60) gaps.push({ startMin: cursor, endMin: 24 * 60 });
      out[d] = gaps;
    }
    return out;
  }, [grouped]);

  const typeColor = (t: string) =>
    t === "live"
      ? "bg-[hsl(var(--live-red))]/85 border-[hsl(var(--live-red))] text-white"
      : t === "jingle"
      ? "bg-[hsl(var(--neon-magenta))]/30 border-[hsl(var(--neon-magenta))]/60 text-foreground"
      : "bg-[hsl(var(--neon-cyan))]/20 border-[hsl(var(--neon-cyan))]/50 text-foreground";

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-gradient-card">
      <div className="min-w-[860px]">
        {/* Header row */}
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border bg-background/40 sticky top-0 z-10">
          <div className="border-r border-border" />
          {DAY_LABELS.map((d, i) => (
            <div key={i} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground border-r border-border last:border-r-0">
              {d}
            </div>
          ))}
        </div>
        {/* Grid body */}
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] relative">
          {/* Hour labels */}
          <div className="border-r border-border">
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} style={{ height: HOUR_PX }} className="px-2 pt-1 text-[10px] tabular-nums text-muted-foreground border-b border-border/40">
                {h.toString().padStart(2, "0")}:00
              </div>
            ))}
          </div>
          {/* Day columns */}
          {DAY_LABELS.map((_, day) => (
            <div key={day} className="relative border-r border-border last:border-r-0">
              {Array.from({ length: 24 }).map((_, h) => (
                <button
                  type="button"
                  key={h}
                  onClick={() => onCreate?.(day, h)}
                  style={{ height: HOUR_PX }}
                  className="block w-full border-b border-border/40 hover:bg-primary/5 transition-colors"
                  aria-label={`Créer un programme ${DAY_LABELS[day]} ${h}h`}
                />
              ))}
              {/* Programs */}
              {(grouped[day] ?? []).map((p) => {
                const startMin = toMin(p.start_time);
                const endMin = toMin(p.end_time);
                const top = (startMin / 60) * HOUR_PX;
                const height = Math.max(((endMin - startMin) / 60) * HOUR_PX, 22);
                const conflict = conflictIds.has(p.id);
                return (
                  <div
                    key={p.id}
                    style={{ top, height }}
                    className={cn(
                      "absolute left-1 right-1 rounded-md border px-1.5 py-1 text-[10px] leading-tight overflow-hidden cursor-pointer group shadow-sm hover:shadow-md transition-shadow",
                      typeColor(p.type),
                      conflict && "ring-2 ring-[hsl(var(--live-red))]",
                    )}
                    onClick={() => onEdit(p)}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1">
                        <div className="font-bold truncate">{p.title || (p.type === "live" ? "Direct" : "Programme")}</div>
                        <div className="opacity-80 tabular-nums">{p.start_time.slice(0, 5)}–{p.end_time.slice(0, 5)}</div>
                      </div>
                      {conflict && <AlertTriangle className="h-3 w-3 shrink-0 text-[hsl(var(--live-red))]" />}
                    </div>
                    <div className="absolute right-0.5 top-0.5 hidden group-hover:flex gap-0.5">
                      <Button variant="ghost" size="icon" className="h-5 w-5 bg-background/80 hover:bg-background" onClick={(e) => { e.stopPropagation(); onEdit(p); }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-5 w-5 bg-background/80 hover:bg-background" onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

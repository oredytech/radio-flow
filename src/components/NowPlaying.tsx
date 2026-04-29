import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Radio as RadioIcon } from "lucide-react";

interface NowPlayingItem {
  radio_id: string;
  active: { id: string; type: "playlist" | "live" | "jingle"; title: string | null; start_time: string; end_time: string } | null;
}

interface Props {
  radioIds: string[];
  refreshMs?: number;
}

export function useNowPlaying({ radioIds, refreshMs = 15000 }: Props) {
  const [items, setItems] = useState<Record<string, NowPlayingItem["active"]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (radioIds.length === 0) { setLoading(false); return; }
    let cancelled = false;
    const fetchOnce = async () => {
      const now = new Date();
      const dow = now.getDay();
      const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/now-playing?radio_ids=${radioIds.join(",")}&dow=${dow}&sec=${sec}`;
      try {
        const res = await fetch(url, {
          headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          cache: "no-store",
        });
        const json = await res.json();
        if (cancelled) return;
        const map: Record<string, NowPlayingItem["active"]> = {};
        for (const it of (json.items ?? []) as NowPlayingItem[]) map[it.radio_id] = it.active;
        setItems(map);
      } catch {
        // silent — widget is non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, refreshMs);
    // Refresh on tab focus
    const onFocus = () => fetchOnce();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [radioIds.join(","), refreshMs]);

  return { items, loading };
}

export function NowPlayingBadge({ active, loading }: { active: NowPlayingItem["active"] | undefined; loading: boolean }) {
  if (loading) {
    return <span className="text-[11px] text-muted-foreground">Chargement…</span>;
  }
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
        Hors antenne
      </span>
    );
  }
  if (active.type === "live") {
    return (
      <span className="live-pulse inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--live-red))] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
        ● En direct
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-foreground">
      <RadioIcon className="h-2.5 w-2.5" />
      À l'antenne
    </span>
  );
}

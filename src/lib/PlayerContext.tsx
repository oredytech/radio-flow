import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRadioEngine } from "@/lib/useRadioEngine";
import { RadioPlayer } from "@/components/RadioPlayer";
import { supabase } from "@/integrations/supabase/client";

interface Ctx {
  activeSlug: string;
  activeName: string | null;
  setActive: (slug: string, name?: string | null) => void;
  /** When true, the global bottom bar exposes the internal AutoDJ source / fade slider. */
  ownerView: boolean;
  setOwnerView: (v: boolean) => void;
  /** ID of the track currently being broadcast on the active radio (null if none). */
  currentTrackId: string | null;
}

const PlayerCtx = createContext<Ctx | null>(null);

/**
 * Provides a single, persistent radio engine across all pages. The bottom bar
 * is rendered once here, so navigation never interrupts playback. Pages call
 * `setActive(slug)` on mount to declare which station should be playing.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const [activeSlug, setActiveSlug] = useState<string>("");
  const [activeName, setActiveName] = useState<string | null>(null);
  const [ownerView, setOwnerView] = useState(false);

  // One single engine instance for the whole app.
  const engine = useRadioEngine(activeSlug);

  // Auto-fetch the radio name when the slug changes (so the bar shows it
  // immediately even before a page sets it explicitly).
  useEffect(() => {
    if (!activeSlug || activeName) return;
    let cancel = false;
    supabase.from("radios").select("name").eq("slug", activeSlug).maybeSingle()
      .then(({ data }) => { if (!cancel && data) setActiveName(data.name); });
    return () => { cancel = true; };
  }, [activeSlug, activeName]);

  const setActive = (slug: string, name?: string | null) => {
    setActiveSlug((curr) => (curr === slug ? curr : slug));
    if (name !== undefined) setActiveName(name);
  };

  return (
    <PlayerCtx.Provider value={{
      activeSlug, activeName, setActive,
      ownerView, setOwnerView,
      currentTrackId: engine.state.currentTrackId,
    }}>
      {children}
      {/* Persistent 40px bottom bar — only renders once a station is active */}
      {activeSlug && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="container mx-auto px-2 py-1 sm:px-3">
            <RadioPlayer slug={activeSlug} radioName={activeName ?? undefined} compact showInternalSource={ownerView} />
          </div>
        </div>
      )}
    </PlayerCtx.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be inside <PlayerProvider>");
  return ctx;
}

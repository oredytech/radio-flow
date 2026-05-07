import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRadioEngine, type EngineState } from "@/lib/useRadioEngine";
import { RadioPlayer } from "@/components/RadioPlayer";
import { supabase } from "@/integrations/supabase/client";

interface Ctx {
  activeSlug: string;
  activeName: string | null;
  setActive: (slug: string, name?: string | null) => void;
  ownerView: boolean;
  setOwnerView: (v: boolean) => void;
  currentTrackId: string | null;
  state: EngineState;
}

const PlayerCtx = createContext<Ctx | null>(null);

/**
 * Single global radio engine + persistent bottom player. Pages call
 * `setActive(slug)` to switch stations; navigation never interrupts audio.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const [activeSlug, setActiveSlug] = useState<string>("");
  const [activeName, setActiveName] = useState<string | null>(null);
  const [ownerView, setOwnerView] = useState(false);

  // ONE engine for the whole app. Sub-components read its state via context.
  const engine = useRadioEngine(activeSlug);

  useEffect(() => {
    if (!activeSlug || activeName) return;
    let cancel = false;
    supabase.from("radios").select("name").eq("slug", activeSlug).maybeSingle()
      .then(({ data }) => { if (!cancel && data) setActiveName(data.name); });
    return () => { cancel = true; };
  }, [activeSlug, activeName]);

  const setActive = (slug: string, name?: string | null) => {
    setActiveSlug((curr) => (curr === slug ? curr : slug));
    if (name !== undefined) setActiveName(name ?? null);
  };

  return (
    <PlayerCtx.Provider value={{
      activeSlug, activeName, setActive,
      ownerView, setOwnerView,
      currentTrackId: engine.state.currentTrackId,
      state: engine.state,
    }}>
      {children}
      {activeSlug && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="container mx-auto px-2 py-1 sm:px-3">
            <RadioPlayer
              slug={activeSlug}
              radioName={activeName ?? undefined}
              compact
              showInternalSource={ownerView}
              externalEngine={engine}
            />
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

/** Read-only hook usable when the provider may not be present (e.g. embed). */
export function usePlayerSafe() {
  return useContext(PlayerCtx);
}

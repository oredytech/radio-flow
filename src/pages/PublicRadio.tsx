import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { RadioPlayer } from "@/components/RadioPlayer";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { DAY_LABELS } from "@/lib/schedule";
import type { Tables } from "@/integrations/supabase/types";
import { Radio as RadioIcon, ArrowLeft, Share2, Upload } from "lucide-react";
import { toast } from "sonner";

type RadioRow = Tables<"radios">;
type Program = Tables<"programs">;

interface UploadStatus { active: boolean; pct: number; remaining: number; etaSec: number | null; ts: number; }

const PublicRadio = () => {
  const { slug = "" } = useParams();
  const [radio, setRadio] = useState<RadioRow | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data: r } = await supabase.from("radios").select("*").eq("slug", slug).maybeSingle();
      if (cancel) return;
      if (!r) { setNotFound(true); return; }
      setRadio(r);
      const { data: ps } = await supabase.from("programs").select("*").eq("radio_id", r.id)
        .order("day_of_week").order("start_time");
      if (!cancel) setPrograms(ps ?? []);
    })();
    return () => { cancel = true; };
  }, [slug]);

  // SEO
  useEffect(() => {
    if (!radio) return;
    document.title = `${radio.name} — Écoutez en direct`;
    const desc = radio.description || `Écoutez ${radio.name} en direct, programmation synchronisée et flux live.`;
    let m = document.querySelector('meta[name="description"]');
    if (!m) { m = document.createElement("meta"); m.setAttribute("name", "description"); document.head.appendChild(m); }
    m.setAttribute("content", desc.slice(0, 158));
    let canon = document.querySelector('link[rel="canonical"]');
    if (!canon) { canon = document.createElement("link"); canon.setAttribute("rel", "canonical"); document.head.appendChild(canon); }
    canon.setAttribute("href", `${window.location.origin}/radio/${radio.slug}`);
  }, [radio]);

  // Discreet upload indicator — only visible to the owner who's currently
  // uploading from another tab (or the same tab in dev). Listens to the
  // LibraryManager broadcast (window event for same-tab, storage event for cross-tab).
  const [upload, setUpload] = useState<UploadStatus | null>(null);
  useEffect(() => {
    if (!radio) return;
    const key = `ir.upload.${radio.slug}`;
    // Hydrate from existing storage entry (if upload was already in progress)
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as UploadStatus;
        if (parsed.active && Date.now() - parsed.ts < 30_000) setUpload(parsed);
      }
    } catch { /* ignore */ }

    const onCustom = (e: Event) => {
      const d = (e as CustomEvent).detail as (UploadStatus & { slug: string }) | undefined;
      if (!d || d.slug !== radio.slug) return;
      setUpload(d.active ? d : null);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key || !e.newValue) { if (e.key === key) setUpload(null); return; }
      try {
        const parsed = JSON.parse(e.newValue) as UploadStatus;
        setUpload(parsed.active ? parsed : null);
      } catch { /* ignore */ }
    };
    window.addEventListener("ir:upload-progress", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("ir:upload-progress", onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, [radio]);

  const fmtEta = (s: number | null) => {
    if (s == null) return "…";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${(s % 60).toString().padStart(2, "0")}s`;
  };

  const grouped = useMemo(() => {
    const m: Record<number, Program[]> = {};
    for (const p of programs) (m[p.day_of_week] ??= []).push(p);
    return m;
  }, [programs]);

  if (notFound) {
    return (
      <div className="grid min-h-screen place-items-center px-4 text-center">
        <div>
          <RadioIcon className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="mt-4 text-2xl font-bold">Radio introuvable</h1>
          <p className="mt-1 text-sm text-muted-foreground">Le slug « {slug} » ne correspond à aucune station.</p>
          <Link to="/" className="mt-4 inline-block text-sm text-primary hover:underline">← Retour à l'accueil</Link>
        </div>
      </div>
    );
  }
  if (!radio) {
    return <div className="grid min-h-screen place-items-center text-muted-foreground">Chargement…</div>;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="container mx-auto flex items-center justify-between px-4 py-3 sm:py-4">
          <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Accueil
          </Link>
          <div className="flex items-center gap-2 text-[11px] sm:text-xs text-muted-foreground truncate max-w-[60%]">
            <RadioIcon className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">/radio/{radio.slug}</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 sm:py-10">
        <section className="mx-auto max-w-3xl">
          <div className="text-[10px] sm:text-xs uppercase tracking-[0.2em] text-muted-foreground">En direct</div>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight sm:text-4xl lg:text-5xl break-words">{radio.name}</h1>
          {radio.description && (
            <p className="mt-3 text-base text-muted-foreground">{radio.description}</p>
          )}

          <div className="mt-6 sm:mt-8">
            <RadioPlayer slug={radio.slug} radioName={radio.name} />
          </div>

          {upload && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
              <Upload className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">
                    Mise à jour de la bibliothèque · {upload.remaining} fichier{upload.remaining > 1 ? "s" : ""}
                  </span>
                  <span className="tabular-nums text-primary">{upload.pct}% · {fmtEta(upload.etaSec)}</span>
                </div>
                <Progress value={upload.pct} className="mt-1 h-1" />
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={async () => {
              const url = window.location.href;
              if (navigator.share) {
                try { await navigator.share({ title: radio.name, url }); return; } catch { /* fallback */ }
              }
              await navigator.clipboard.writeText(url);
              toast.success("Lien copié");
            }}>
              <Share2 className="mr-1.5 h-3.5 w-3.5" /> Partager cette radio
            </Button>
          </div>

          <div className="mt-8 sm:mt-10">
            <h2 className="text-base sm:text-lg font-semibold">Grille de la semaine</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {DAY_LABELS.map((d, i) => (
                <div key={i} className="rounded-xl border border-border bg-gradient-card p-4">
                  <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">{d}</div>
                  {(grouped[i] ?? []).length === 0 ? (
                    <div className="text-sm text-muted-foreground/70">Pas de programme</div>
                  ) : (
                    <ul className="space-y-1.5">
                      {grouped[i].map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            p.type === "live"
                              ? "bg-[hsl(var(--live-red))] text-white"
                              : p.type === "jingle"
                                ? "bg-[hsl(var(--neon-magenta))]/25 text-[hsl(var(--neon-magenta))]"
                                : "bg-secondary text-foreground"
                          }`}>{p.type === "live" ? "Direct" : p.type === "jingle" ? "Jingle" : "Playlist"}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {p.start_time.slice(0,5)}–{p.end_time.slice(0,5)}
                          </span>
                          <span className="truncate">{p.title || "(sans titre)"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default PublicRadio;

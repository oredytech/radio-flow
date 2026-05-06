import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { RadioPlayer } from "@/components/RadioPlayer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { Tables } from "@/integrations/supabase/types";
import {
  Radio as RadioIcon, ArrowLeft, Share2, Upload, Code2, Copy, Check,
  Link2, Calendar, Music, Headphones,
} from "lucide-react";
import { toast } from "sonner";

type RadioRow = Tables<"radios"> & { cover_url?: string | null; avatar_url?: string | null };

interface UploadStatus { active: boolean; pct: number; remaining: number; etaSec: number | null; ts: number; }

const PublicRadio = () => {
  const { slug = "" } = useParams();
  const [radio, setRadio] = useState<RadioRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [embedAutoplay, setEmbedAutoplay] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data: r } = await supabase.from("radios").select("*").eq("slug", slug).maybeSingle();
      if (cancel) return;
      if (!r) { setNotFound(true); return; }
      setRadio(r as RadioRow);
    })();
    return () => { cancel = true; };
  }, [slug]);

  // SEO
  useEffect(() => {
    if (!radio) return;
    document.title = `${radio.name} — Écoutez en direct`;
    const desc = radio.description || `Écoutez ${radio.name} en direct, 24h/24 et 7j/7.`;
    let m = document.querySelector('meta[name="description"]');
    if (!m) { m = document.createElement("meta"); m.setAttribute("name", "description"); document.head.appendChild(m); }
    m.setAttribute("content", desc.slice(0, 158));
    let canon = document.querySelector('link[rel="canonical"]');
    if (!canon) { canon = document.createElement("link"); canon.setAttribute("rel", "canonical"); document.head.appendChild(canon); }
    canon.setAttribute("href", `${window.location.origin}/radio/${radio.slug}`);
  }, [radio]);

  // Owner-side upload progress (kept from before)
  const [upload, setUpload] = useState<UploadStatus | null>(null);
  useEffect(() => {
    if (!radio) return;
    const key = `ir.upload.${radio.slug}`;
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

  const publicUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/radio/${radio.slug}`;
  const embedUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/embed/${radio.slug}${embedAutoplay ? "?autoplay=1" : ""}`;
  const embedSnippet = `<iframe src="${embedUrl}" width="100%" height="80" frameborder="0" allow="autoplay"></iframe>`;
  const supaFnBase = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stream`;
  const streamM3U8 = `${supaFnBase}/${radio.slug}.m3u8`;
  const streamPLS = `${supaFnBase}/${radio.slug}.pls`;
  const streamM3U = `${supaFnBase}/${radio.slug}.m3u`;

  const copyText = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${label} copié`); }
    catch { toast.error("Copie impossible"); }
  };
  const copyEmbed = async () => {
    await navigator.clipboard.writeText(embedSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success("Code d'intégration copié");
  };
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: radio.name, url: publicUrl }); return; } catch { /* fallback */ }
    }
    await navigator.clipboard.writeText(publicUrl);
    toast.success("Lien copié");
  };

  const initials = radio.name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("") || "R";

  return (
    <div className="min-h-screen pb-14">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="container mx-auto flex items-center justify-between px-4 py-2.5">
          <Link to="/" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Accueil
          </Link>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate max-w-[55%]">
            <RadioIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">/radio/{radio.slug}</span>
          </div>
        </div>
      </header>

      {/* ─── COVER ─────────────────────────────────────────────── */}
      <section className="relative">
        <div
          className="h-44 w-full sm:h-64 md:h-80"
          style={{
            backgroundImage: radio.cover_url
              ? `url(${radio.cover_url})`
              : "var(--gradient-brand)",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <div className="h-full w-full bg-gradient-to-t from-background via-background/30 to-transparent" />
        </div>
      </section>

      {/* ─── PROFILE HEADER ───────────────────────────────────── */}
      <section className="container mx-auto px-4">
        <div className="-mt-14 flex flex-col gap-4 sm:-mt-16 sm:flex-row sm:items-end">
          {/* Avatar */}
          <div className="relative shrink-0">
            <div className="h-28 w-28 overflow-hidden rounded-2xl border-4 border-background bg-card shadow-elevated sm:h-32 sm:w-32">
              {radio.avatar_url ? (
                <img src={radio.avatar_url} alt={radio.name} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center bg-gradient-brand text-3xl font-extrabold text-primary-foreground">
                  {initials}
                </div>
              )}
            </div>
          </div>

          {/* Name / actions */}
          <div className="min-w-0 flex-1 sm:pb-2">
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{radio.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-semibold uppercase tracking-wider text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /> En direct 24/7
              </span>
              <span className="inline-flex items-center gap-1"><RadioIcon className="h-3 w-3" /> /radio/{radio.slug}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 sm:pb-2">
            <Button size="sm" variant="default" className="bg-gradient-brand text-primary-foreground" onClick={share}>
              <Share2 className="mr-1.5 h-3.5 w-3.5" /> Partager
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEmbedOpen(true)}>
              <Code2 className="mr-1.5 h-3.5 w-3.5" /> Intégrer
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLinksOpen(true)}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" /> Flux
            </Button>
          </div>
        </div>

        {/* Owner upload bar */}
        {upload && (
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
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

        {/* ─── ABOUT GRID ─────────────────────────────────────── */}
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {/* About */}
          <div className="rounded-xl border border-border bg-gradient-card p-5 md:col-span-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">À propos</h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
              {radio.description || "Cette station diffuse en continu 24h/24 et 7j/7. Restez à l'écoute pour découvrir notre programmation."}
            </p>
          </div>

          {/* Quick info */}
          <div className="rounded-xl border border-border bg-gradient-card p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Infos</h2>
            <ul className="mt-3 space-y-2.5 text-sm">
              <li className="flex items-center gap-2.5">
                <Headphones className="h-4 w-4 text-primary" />
                <span>Écoute web, mobile et VLC</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Music className="h-4 w-4 text-primary" />
                <span>Diffusion automatique ininterrompue</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Calendar className="h-4 w-4 text-primary" />
                <span>Programmation hebdomadaire</span>
              </li>
              <li className="flex items-center gap-2.5">
                <RadioIcon className="h-4 w-4 text-primary" />
                <span className="truncate">/radio/{radio.slug}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ─── FIXED 40px PLAYER (always visible) ─────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="container mx-auto px-2 py-1 sm:px-3">
          <RadioPlayer slug={radio.slug} radioName={radio.name} compact />
        </div>
      </div>

      {/* ─── EMBED DIALOG ───────────────────────────────────── */}
      <Dialog open={embedOpen} onOpenChange={setEmbedOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Code2 className="h-4 w-4" /> Intégrer le player</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center justify-between rounded border border-border bg-background/50 p-2 text-xs">
              <span className="font-semibold">Lecture automatique</span>
              <input type="checkbox" className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
                checked={embedAutoplay} onChange={(e) => setEmbedAutoplay(e.target.checked)} />
            </label>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-background p-3 text-[11px] leading-relaxed">
{embedSnippet}
            </pre>
            <Button variant="outline" size="sm" className="w-full" onClick={copyEmbed}>
              {copied ? <><Check className="mr-1.5 h-3.5 w-3.5" /> Copié</> : <><Copy className="mr-1.5 h-3.5 w-3.5" /> Copier le code</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── LINKS DIALOG ───────────────────────────────────── */}
      <Dialog open={linksOpen} onOpenChange={setLinksOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Flux & liens</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {([
              { label: "Page d'écoute", url: publicUrl },
              { label: "HLS (.m3u8)", url: streamM3U8 },
              { label: "PLS (.pls)", url: streamPLS },
              { label: "M3U (.m3u)", url: streamM3U },
            ]).map((s) => (
              <div key={s.label}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</div>
                <div className="flex gap-1.5">
                  <a href={s.url} target="_blank" rel="noreferrer"
                     className="block min-w-0 flex-1 truncate rounded bg-background p-2 text-[11px] text-primary hover:underline">{s.url}</a>
                  <Button variant="outline" size="sm" onClick={() => copyText(s.url, s.label)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// silence unused import warnings if any
void DialogTrigger;

export default PublicRadio;

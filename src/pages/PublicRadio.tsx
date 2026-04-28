import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { RadioPlayer } from "@/components/RadioPlayer";
import { DAY_LABELS } from "@/lib/schedule";
import type { Tables } from "@/integrations/supabase/types";
import { Radio as RadioIcon, ArrowLeft } from "lucide-react";

type RadioRow = Tables<"radios">;
type Program = Tables<"programs">;

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
        <div className="container mx-auto flex items-center justify-between py-4">
          <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Accueil
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RadioIcon className="h-3.5 w-3.5" /> /radio/{radio.slug}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-10">
        <section className="mx-auto max-w-3xl">
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">En direct</div>
          <h1 className="mt-2 text-4xl font-extrabold tracking-tight sm:text-5xl">{radio.name}</h1>
          {radio.description && (
            <p className="mt-3 text-base text-muted-foreground">{radio.description}</p>
          )}

          <div className="mt-8">
            <RadioPlayer slug={radio.slug} radioName={radio.name} />
          </div>

          <div className="mt-10">
            <h2 className="text-lg font-semibold">Grille de la semaine</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {DAY_LABELS.map((d, i) => (
                <div key={i} className="rounded-xl border border-border bg-gradient-card p-4">
                  <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">{d}</div>
                  {(grouped[i] ?? []).length === 0 ? (
                    <div className="text-sm text-muted-foreground/70">Pas de programme</div>
                  ) : (
                    <ul className="space-y-1.5">
                      {grouped[i].map((p) => (
                        <li key={p.id} className="flex items-center gap-2 text-sm">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            p.type === "live"
                              ? "bg-[hsl(var(--live-red))] text-white"
                              : "bg-secondary text-foreground"
                          }`}>{p.type === "live" ? "Direct" : "Playlist"}</span>
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

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Plus, Trash2, Radio as RadioIcon, Copy, Check, Pencil, AlertTriangle, Share2 } from "lucide-react";
import { toast } from "sonner";
import { RadioPlayer } from "@/components/RadioPlayer";
import { LibraryManager } from "@/components/LibraryManager";
import { DAY_LABELS, findOverlaps, overlapsExisting } from "@/lib/schedule";
import type { Tables } from "@/integrations/supabase/types";

type RadioRow = Tables<"radios">;
type Program = Tables<"programs">;
type Track = Tables<"tracks">;

type ProgType = "playlist" | "live" | "jingle";

interface FormState {
  id?: string;
  type: ProgType;
  title: string;
  day: string;
  start: string;
  end: string;
  audioUrl: string;     // chosen URL for playlist/jingle (from library or external)
  audioSource: "library" | "url";
  audioTrackId: string; // when audioSource = "library"
  streamUrl: string;
}

const emptyForm = (): FormState => ({
  type: "playlist", title: "", day: "1",
  start: "09:00", end: "12:00",
  audioUrl: "", audioSource: "library", audioTrackId: "",
  streamUrl: "",
});

const TYPE_LABELS: Record<ProgType, string> = {
  playlist: "Playlist (synchronisée)",
  live: "Direct (flux externe)",
  jingle: "Jingle (ponctuel, non bouclé)",
};

const RadioDetail = () => {
  const { id } = useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [radio, setRadio] = useState<RadioRow | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  const [embedAutoplay, setEmbedAutoplay] = useState<boolean>(() => {
    try { return localStorage.getItem("ir.embed.autoplay") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ir.embed.autoplay", embedAutoplay ? "1" : "0"); } catch { /* ignore */ }
  }, [embedAutoplay]);

  useEffect(() => { if (!loading && !user) navigate("/auth"); }, [user, loading, navigate]);

  useEffect(() => {
    if (!id) return;
    supabase.from("radios").select("*").eq("id", id).maybeSingle()
      .then(({ data }) => setRadio(data));
    supabase.from("programs").select("*").eq("radio_id", id)
      .order("day_of_week").order("start_time")
      .then(({ data }) => setPrograms(data ?? []));
    supabase.from("tracks").select("*").eq("radio_id", id)
      .then(({ data }) => setTracks(data ?? []));
  }, [id]);

  const embedUrl = `${window.location.origin}/embed/${radio?.slug ?? ""}${embedAutoplay ? "?autoplay=1" : ""}`;
  const embedSnippet = `<iframe src="${embedUrl}" width="100%" height="120" frameborder="0" allow="autoplay"></iframe>`;
  const publicUrl = `${window.location.origin}/radio/${radio?.slug ?? ""}`;

  const copyEmbed = async () => {
    await navigator.clipboard.writeText(embedSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success("Code d'intégration copié");
  };

  const copyPublicUrl = async () => {
    await navigator.clipboard.writeText(publicUrl);
    toast.success("Lien d'écoute copié");
  };

  const conflictPairs = useMemo(() => findOverlaps(programs), [programs]);
  const conflictIds = useMemo(() => {
    const s = new Set<string>();
    for (const [a, b] of conflictPairs) { s.add(a.id); s.add(b.id); }
    return s;
  }, [conflictPairs]);

  // Resolve effective audio URL from form
  const effectiveAudioUrl = useMemo(() => {
    if (form.audioSource === "library") {
      const t = tracks.find((x) => x.id === form.audioTrackId);
      return t?.audio_url ?? "";
    }
    return form.audioUrl;
  }, [form.audioSource, form.audioTrackId, form.audioUrl, tracks]);

  const formError = useMemo(() => {
    if (!radio) return null;
    if (form.end <= form.start) return "L'heure de fin doit être après le début.";
    if ((form.type === "playlist" || form.type === "jingle") && !effectiveAudioUrl) {
      return "Sélectionnez ou indiquez un audio.";
    }
    if (form.type === "live" && !form.streamUrl) return "URL de stream requise pour un direct.";
    if (form.type !== "jingle" && overlapsExisting(programs, {
      id: form.id,
      radio_id: radio.id,
      day_of_week: Number(form.day),
      type: form.type,
      start_time: form.start,
      end_time: form.end,
    })) {
      return `Chevauchement avec une autre programmation ${form.type === "live" ? "en direct" : "playlist"} ce jour-là.`;
    }
    return null;
  }, [form, programs, radio, effectiveAudioUrl]);

  const openCreate = () => { setForm(emptyForm()); setOpen(true); };
  const openEdit = (p: Program) => {
    // Prefill audioSource based on whether the audio_url matches a track
    const matched = tracks.find((t) => t.audio_url === p.audio_url);
    setForm({
      id: p.id,
      type: p.type as ProgType,
      title: p.title ?? "",
      day: String(p.day_of_week),
      start: p.start_time.slice(0, 5),
      end: p.end_time.slice(0, 5),
      audioUrl: matched ? "" : (p.audio_url ?? ""),
      audioSource: matched ? "library" : (p.audio_url ? "url" : "library"),
      audioTrackId: matched?.id ?? "",
      streamUrl: p.stream_url ?? "",
    });
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!radio || formError) return;
    setSaving(true);
    const payload = {
      radio_id: radio.id,
      type: form.type,
      title: form.title || null,
      day_of_week: Number(form.day),
      start_time: form.start,
      end_time: form.end,
      audio_url: form.type === "live" ? null : effectiveAudioUrl,
      stream_url: form.type === "live" ? form.streamUrl : null,
    };
    if (form.id) {
      const { data, error } = await supabase.from("programs").update(payload).eq("id", form.id).select().single();
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      setPrograms((p) => p.map((x) => x.id === form.id ? data : x)
        .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)));
      toast.success("Programme mis à jour");
    } else {
      const { data, error } = await supabase.from("programs").insert(payload).select().single();
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      setPrograms((p) => [...p, data]
        .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)));
      toast.success("Programme ajouté");
    }
    setOpen(false);
    setForm(emptyForm());
  };

  const removeProgram = async (pid: string) => {
    const { error } = await supabase.from("programs").delete().eq("id", pid);
    if (error) { toast.error(error.message); return; }
    setPrograms((p) => p.filter((x) => x.id !== pid));
    toast.success("Programme supprimé");
  };

  const grouped = useMemo(() => {
    const m: Record<number, Program[]> = {};
    for (const p of programs) (m[p.day_of_week] ??= []).push(p);
    return m;
  }, [programs]);

  if (!radio) return <div className="grid min-h-screen place-items-center text-muted-foreground">Chargement…</div>;

  const typeBadgeClass = (t: string) =>
    t === "live"
      ? "bg-[hsl(var(--live-red))] text-white"
      : t === "jingle"
        ? "bg-[hsl(var(--neon-magenta))]/25 text-[hsl(var(--neon-magenta))]"
        : "bg-secondary text-foreground";
  const typeLabel = (t: string) => t === "live" ? "Direct" : t === "jingle" ? "Jingle" : "Playlist";

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="container mx-auto flex items-center justify-between gap-2 px-4 py-3 sm:py-4">
          <Link to="/dashboard" className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> <span className="hidden xs:inline">Retour</span>
          </Link>
          <a href={publicUrl} target="_blank" rel="noreferrer"
             className="flex min-w-0 items-center gap-2 text-[11px] sm:text-xs text-muted-foreground hover:text-foreground">
            <RadioIcon className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">/radio/{radio.slug}</span>
          </a>
        </div>
      </header>

      <main className="container mx-auto px-4 py-5 sm:py-8">
        <h1 className="text-xl font-bold sm:text-3xl break-words">{radio.name}</h1>

        {conflictPairs.length > 0 && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-[hsl(var(--live-red))]/40 bg-[hsl(var(--live-red))]/10 p-3 text-sm sm:p-4">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[hsl(var(--live-red))]" />
            <div>
              <div className="font-semibold text-[hsl(var(--live-red))]">
                {conflictPairs.length} chevauchement{conflictPairs.length > 1 ? "s" : ""} détecté{conflictPairs.length > 1 ? "s" : ""}
              </div>
              <div className="mt-1 text-muted-foreground">
                Modifiez ou supprimez les programmes en conflit pour assurer une diffusion sans coupure.
              </div>
            </div>
          </div>
        )}

        {/* Live preview FIRST on mobile */}
        <div className="mt-6 lg:hidden">
          <RadioPlayer slug={radio.slug} radioName={radio.name} />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr,360px]">
          <section className="min-w-0">
            <Tabs defaultValue="schedule" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="schedule">Programmation</TabsTrigger>
                <TabsTrigger value="library">Bibliothèque ({tracks.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="schedule" className="mt-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold sm:text-lg">Grille hebdomadaire</h2>
                  <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForm(emptyForm()); }}>
                    <DialogTrigger asChild>
                      <Button size="sm" onClick={openCreate} className="bg-gradient-brand text-primary-foreground">
                        <Plus className="mr-1.5 h-4 w-4" /> Programme
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-h-[90vh] overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>{form.id ? "Modifier le programme" : "Nouveau programme"}</DialogTitle>
                      </DialogHeader>
                      <form onSubmit={submit} className="space-y-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <Label>Type</Label>
                            <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as ProgType }))}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(Object.keys(TYPE_LABELS) as ProgType[]).map((k) => (
                                  <SelectItem key={k} value={k}>{TYPE_LABELS[k]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label>Jour</Label>
                            <Select value={form.day} onValueChange={(v) => setForm((f) => ({ ...f, day: v }))}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {DAY_LABELS.map((d, i) => (
                                  <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div>
                          <Label htmlFor="title">Titre (optionnel)</Label>
                          <Input id="title" value={form.title}
                            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                            placeholder="Matinale du jour" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label htmlFor="start">Début</Label>
                            <Input id="start" type="time" required value={form.start}
                              onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} />
                          </div>
                          <div>
                            <Label htmlFor="end">Fin</Label>
                            <Input id="end" type="time" required value={form.end}
                              onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} />
                          </div>
                        </div>

                        {form.type === "live" ? (
                          <div>
                            <Label htmlFor="stream">URL du stream</Label>
                            <Input id="stream" type="url" required value={form.streamUrl}
                              onChange={(e) => setForm((f) => ({ ...f, streamUrl: e.target.value }))}
                              placeholder="https://…/stream" />
                            <p className="mt-1 text-xs text-muted-foreground">Diffusé en temps réel — aucun offset appliqué.</p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Label>Audio</Label>
                            <div className="flex gap-2 text-xs">
                              <button type="button"
                                onClick={() => setForm((f) => ({ ...f, audioSource: "library" }))}
                                className={`flex-1 rounded-md border px-3 py-1.5 ${form.audioSource === "library" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background"}`}>
                                Depuis la bibliothèque
                              </button>
                              <button type="button"
                                onClick={() => setForm((f) => ({ ...f, audioSource: "url" }))}
                                className={`flex-1 rounded-md border px-3 py-1.5 ${form.audioSource === "url" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background"}`}>
                                URL externe
                              </button>
                            </div>
                            {form.audioSource === "library" ? (
                              tracks.length === 0 ? (
                                <p className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground">
                                  Bibliothèque vide. Allez dans l'onglet Bibliothèque pour uploader des audios.
                                </p>
                              ) : (
                                <Select value={form.audioTrackId} onValueChange={(v) => setForm((f) => ({ ...f, audioTrackId: v }))}>
                                  <SelectTrigger><SelectValue placeholder="Choisir une piste" /></SelectTrigger>
                                  <SelectContent>
                                    {tracks
                                      .slice()
                                      .sort((a, b) => a.position - b.position)
                                      .map((t) => (
                                        <SelectItem key={t.id} value={t.id}>
                                          [{t.kind === "jingle" ? "Jingle" : "Musique"}] {t.title}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              )
                            ) : (
                              <Input type="url" value={form.audioUrl}
                                onChange={(e) => setForm((f) => ({ ...f, audioUrl: e.target.value }))}
                                placeholder="https://…/track.mp3" />
                            )}
                            <p className="text-xs text-muted-foreground">
                              {form.type === "playlist"
                                ? "Synchronisé au temps serveur, boucle dans la fenêtre."
                                : "Joué une seule fois à l'heure indiquée puis l'antenne reprend."}
                            </p>
                          </div>
                        )}

                        {formError && (
                          <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--live-red))]/40 bg-[hsl(var(--live-red))]/10 p-2.5 text-xs text-[hsl(var(--live-red))]">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{formError}</span>
                          </div>
                        )}

                        <Button type="submit" disabled={saving || !!formError}
                          className="w-full bg-gradient-brand text-primary-foreground disabled:opacity-50">
                          {saving ? "Enregistrement…" : form.id ? "Enregistrer les modifications" : "Ajouter le programme"}
                        </Button>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>

                <div className="mt-4 space-y-3">
                  {DAY_LABELS.map((d, i) => (
                    <div key={i} className="rounded-xl border border-border bg-gradient-card p-3 sm:p-4">
                      <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">{d}</div>
                      {(grouped[i] ?? []).length === 0 ? (
                        <div className="text-sm text-muted-foreground/70">Aucune programmation</div>
                      ) : (
                        <ul className="divide-y divide-border">
                          {grouped[i].map((p) => {
                            const conflict = conflictIds.has(p.id);
                            return (
                              <li key={p.id} className={`flex items-center justify-between gap-2 py-2 ${conflict ? "rounded-md bg-[hsl(var(--live-red))]/5 px-2" : ""}`}>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${typeBadgeClass(p.type)}`}>
                                      {typeLabel(p.type)}
                                    </span>
                                    <span className="truncate text-sm font-medium">{p.title || "(sans titre)"}</span>
                                    {conflict && (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--live-red))]">
                                        <AlertTriangle className="h-3 w-3" /> Chevauchement
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {p.start_time.slice(0,5)} – {p.end_time.slice(0,5)}
                                  </div>
                                </div>
                                <div className="flex items-center gap-0.5">
                                  <Button variant="ghost" size="icon" onClick={() => openEdit(p)} title="Modifier" className="h-8 w-8">
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" onClick={() => removeProgram(p.id)} title="Supprimer" className="h-8 w-8">
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="library" className="mt-4">
                {user && (
                  <LibraryManager
                    radioId={radio.id}
                    userId={user.id}
                    tracks={tracks}
                    onChange={setTracks}
                  />
                )}
              </TabsContent>
            </Tabs>
          </section>

          <aside className="space-y-4">
            {/* Hide preview here on mobile (already shown above) */}
            <div className="hidden lg:block">
              <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Aperçu en direct</div>
              <RadioPlayer slug={radio.slug} radioName={radio.name} />
            </div>

            <div className="rounded-xl border border-border bg-gradient-card p-4">
              <div className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">Lien d'écoute</div>
              <a href={publicUrl} target="_blank" rel="noreferrer"
                 className="block break-all rounded-md bg-background p-2 text-xs text-primary hover:underline">
                {publicUrl}
              </a>
              <Button variant="outline" size="sm" className="mt-2 w-full" onClick={copyPublicUrl}>
                <Share2 className="mr-1.5 h-3.5 w-3.5" /> Copier le lien
              </Button>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Partagez ce lien : tous les auditeurs entendront la même chose au même moment.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-gradient-card p-4">
              <div className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">Code d'intégration</div>

              <label className="mb-3 flex cursor-pointer items-center justify-between rounded-md border border-border bg-background/50 p-2.5 text-xs">
                <div>
                  <div className="font-semibold text-foreground">Lecture automatique</div>
                  <div className="text-muted-foreground">Préférence enregistrée sur cet appareil.</div>
                </div>
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
                  checked={embedAutoplay}
                  onChange={(e) => setEmbedAutoplay(e.target.checked)}
                />
              </label>

              <pre className="overflow-x-auto rounded-md bg-background p-3 text-[11px] leading-relaxed text-foreground/80">
{embedSnippet}
              </pre>
              <Button variant="outline" size="sm" className="mt-2 w-full" onClick={copyEmbed}>
                {copied ? <><Check className="mr-1.5 h-3.5 w-3.5" /> Copié</> : <><Copy className="mr-1.5 h-3.5 w-3.5" /> Copier</>}
              </Button>
              <a href={`/embed/${radio.slug}${embedAutoplay ? "?autoplay=1" : ""}`} target="_blank" rel="noreferrer"
                className="mt-2 block text-center text-xs text-primary hover:underline">
                Ouvrir la page d'intégration →
              </a>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default RadioDetail;

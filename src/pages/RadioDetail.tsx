import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  ArrowLeft, Plus, Trash2, Radio as RadioIcon, Copy, Check, AlertTriangle,
  Share2, ArrowUp, ArrowDown, GripVertical, Link2, Calendar, Library, Settings,
  Music, ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { RadioPlayer } from "@/components/RadioPlayer";
import { LibraryManager } from "@/components/LibraryManager";
import { ProgramCalendar } from "@/components/ProgramCalendar";
import { BroadcastTargets } from "@/components/BroadcastTargets";
import { RadioBrandingDialog } from "@/components/RadioBrandingDialog";
import { DAY_LABELS, findOverlaps, overlapsExisting } from "@/lib/schedule";
import { useRadioEngine } from "@/lib/useRadioEngine";
import { cn } from "@/lib/utils";
import type { Tables } from "@/integrations/supabase/types";

type RadioRow = Tables<"radios">;
type Program = Tables<"programs">;
type Track = Tables<"tracks">;
type Folder = Tables<"track_folders">;
type ProgramTrack = Tables<"program_tracks"> & { track?: Track | null };

type ProgType = "playlist" | "live" | "jingle";
type View = "schedule" | "library";

interface TimeSlot { day: string; start: string; end: string; }

interface FormState {
  id?: string;
  type: ProgType;
  title: string;
  slots: TimeSlot[];
  audioUrl: string;
  audioSource: "library" | "url";
  audioTrackIds: string[];
  streamUrl: string;
}

const emptyForm = (): FormState => ({
  type: "playlist", title: "", slots: [{ day: "1", start: "09:00", end: "12:00" }],
  audioUrl: "", audioSource: "library", audioTrackIds: [],
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
  const [folders, setFolders] = useState<Folder[]>([]);
  const [programTracks, setProgramTracks] = useState<ProgramTrack[]>([]);
  const [open, setOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [view, setView] = useState<View>("schedule");
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Live engine — drives the fixed bottom player AND highlights the current track in the library.
  const engine = useRadioEngine(radio?.slug ?? "");

  const reorderTracks = (from: number, to: number) => {
    setForm((f) => {
      if (from === to || from < 0 || to < 0 || from >= f.audioTrackIds.length || to >= f.audioTrackIds.length) return f;
      const a = [...f.audioTrackIds];
      const [moved] = a.splice(from, 1);
      a.splice(to, 0, moved);
      return { ...f, audioTrackIds: a };
    });
  };

  const [embedAutoplay, setEmbedAutoplay] = useState<boolean>(() => {
    try { return localStorage.getItem("ir.embed.autoplay") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ir.embed.autoplay", embedAutoplay ? "1" : "0"); } catch { /* ignore */ }
  }, [embedAutoplay]);

  useEffect(() => { if (!loading && !user) navigate("/auth"); }, [user, loading, navigate]);

  useEffect(() => {
    if (!id) return;
    supabase.from("radios").select("*").eq("id", id).maybeSingle().then(({ data }) => setRadio(data));
    supabase.from("programs").select("*").eq("radio_id", id)
      .order("day_of_week").order("start_time")
      .then(({ data }) => setPrograms(data ?? []));
    supabase.from("tracks").select("*").eq("radio_id", id).then(({ data }) => setTracks(data ?? []));
    supabase.from("track_folders").select("*").eq("radio_id", id).order("position")
      .then(({ data }) => setFolders(data ?? []));
    supabase.from("program_tracks").select("*, track:tracks(*)").order("position")
      .then(({ data }) => setProgramTracks((data ?? []).filter((pt) => pt.track?.radio_id === id) as ProgramTrack[]));
  }, [id]);

  const embedUrl = `${window.location.origin}/embed/${radio?.slug ?? ""}${embedAutoplay ? "?autoplay=1" : ""}`;
  const embedSnippet = `<iframe src="${embedUrl}" width="100%" height="120" frameborder="0" allow="autoplay"></iframe>`;
  const publicUrl = `${window.location.origin}/radio/${radio?.slug ?? ""}`;
  const supaFnBase = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stream`;
  const streamM3U8 = radio ? `${supaFnBase}/${radio.slug}.m3u8` : "";
  const streamPLS = radio ? `${supaFnBase}/${radio.slug}.pls` : "";
  const streamM3U = radio ? `${supaFnBase}/${radio.slug}.m3u` : "";

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

  const conflictPairs = useMemo(() => findOverlaps(programs), [programs]);
  const conflictIds = useMemo(() => {
    const s = new Set<string>();
    for (const [a, b] of conflictPairs) { s.add(a.id); s.add(b.id); }
    return s;
  }, [conflictPairs]);

  const effectiveAudioUrl = useMemo(() => {
    if (form.audioSource === "library") return tracks.find((x) => x.id === form.audioTrackIds[0])?.audio_url ?? "";
    return form.audioUrl;
  }, [form.audioSource, form.audioTrackIds, form.audioUrl, tracks]);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const schedulableTracks = useMemo(() => tracks
    .filter((t) => {
      const folder = t.folder_id ? folderById.get(t.folder_id) : null;
      return !folder || folder.kind === "shows" || folder.kind === "jingles";
    })
    .sort((a, b) => (folderById.get(a.folder_id ?? "")?.position ?? 99) - (folderById.get(b.folder_id ?? "")?.position ?? 99) || a.position - b.position),
  [tracks, folderById]);
  const selectedTracks = useMemo(() => form.audioTrackIds
    .map((trackId) => tracks.find((t) => t.id === trackId))
    .filter(Boolean) as Track[], [form.audioTrackIds, tracks]);

  const formError = useMemo(() => {
    if (!radio) return null;
    if (form.slots.some((slot) => slot.end <= slot.start)) return "L'heure de fin doit être après le début.";
    if (form.type !== "live" && form.audioSource === "library" && form.audioTrackIds.length === 0) return "Sélectionnez au moins une piste.";
    if (form.type !== "live" && form.audioSource === "url" && !form.audioUrl) return "Indiquez une URL audio.";
    if (form.type === "live" && !form.streamUrl) return "URL de stream requise pour un direct.";
    if (form.type !== "jingle" && form.slots.some((slot) => overlapsExisting(programs, {
      id: form.id, radio_id: radio.id, day_of_week: Number(slot.day), type: form.type,
      start_time: slot.start, end_time: slot.end,
    }))) {
      return `Chevauchement avec une autre programmation ${form.type === "live" ? "en direct" : "playlist"} ce jour-là.`;
    }
    return null;
  }, [form, programs, radio]);

  const refreshProgramTracks = async () => {
    if (!radio) return;
    const { data } = await supabase.from("program_tracks").select("*, track:tracks(*)").order("position");
    setProgramTracks((data ?? []).filter((pt) => pt.track?.radio_id === radio.id) as ProgramTrack[]);
  };

  const saveProgramTracks = async (programId: string) => {
    await supabase.from("program_tracks").delete().eq("program_id", programId);
    if (form.type === "live" || form.audioSource !== "library" || form.audioTrackIds.length === 0) return null;
    return supabase.from("program_tracks").insert(
      form.audioTrackIds.map((trackId, position) => ({ program_id: programId, track_id: trackId, position })),
    );
  };

  const openCreate = () => { setForm(emptyForm()); setOpen(true); };
  const openCreateAt = (day: number, hour: number) => {
    const start = `${hour.toString().padStart(2, "0")}:00`;
    const end = `${(hour + 1).toString().padStart(2, "0")}:00`;
    setForm({ ...emptyForm(), slots: [{ day: String(day), start, end }] });
    setOpen(true);
  };
  const openEdit = (p: Program) => {
    const linked = programTracks.filter((pt) => pt.program_id === p.id).sort((a, b) => a.position - b.position);
    const matched = tracks.find((t) => t.audio_url === p.audio_url);
    setForm({
      id: p.id,
      type: p.type as ProgType,
      title: p.title ?? "",
      slots: [{ day: String(p.day_of_week), start: p.start_time.slice(0, 5), end: p.end_time.slice(0, 5) }],
      audioUrl: linked.length || matched ? "" : (p.audio_url ?? ""),
      audioSource: linked.length || matched ? "library" : (p.audio_url ? "url" : "library"),
      audioTrackIds: linked.length ? linked.map((pt) => pt.track_id) : (matched ? [matched.id] : []),
      streamUrl: p.stream_url ?? "",
    });
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!radio || formError) return;
    setSaving(true);
    const toPayload = (slot: TimeSlot) => ({
      radio_id: radio.id,
      type: form.type,
      title: form.title || null,
      day_of_week: Number(slot.day),
      start_time: slot.start,
      end_time: slot.end,
      audio_url: form.type === "live" ? null : effectiveAudioUrl,
      stream_url: form.type === "live" ? form.streamUrl : null,
    });
    if (form.id) {
      const { data, error } = await supabase.from("programs").update(toPayload(form.slots[0])).eq("id", form.id).select().single();
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      const rel = await saveProgramTracks(form.id);
      if (rel?.error) { toast.error(rel.error.message); return; }
      await refreshProgramTracks();
      setPrograms((p) => p.map((x) => x.id === form.id ? data : x)
        .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)));
      toast.success("Programme mis à jour");
    } else {
      const { data, error } = await supabase.from("programs").insert(form.slots.map(toPayload)).select();
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      for (const row of data ?? []) {
        const rel = await saveProgramTracks(row.id);
        if (rel?.error) { toast.error(rel.error.message); return; }
      }
      await refreshProgramTracks();
      setPrograms((p) => [...p, ...(data ?? [])]
        .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)));
      toast.success(form.slots.length > 1 ? "Programmes ajoutés" : "Programme ajouté");
    }
    setOpen(false);
    setForm(emptyForm());
  };

  const removeProgram = async (pid: string) => {
    if (!confirm("Supprimer ce programme ?")) return;
    const { error } = await supabase.from("programs").delete().eq("id", pid);
    if (error) { toast.error(error.message); return; }
    setPrograms((p) => p.filter((x) => x.id !== pid));
    toast.success("Programme supprimé");
  };

  if (!radio) return <div className="grid min-h-screen place-items-center text-muted-foreground">Chargement…</div>;

  return (
    <div className="min-h-screen pb-28">
      {/* ─── TOP BAR ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container mx-auto flex items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Link to="/dashboard" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold sm:text-base">{radio.name}</h1>
              <a href={publicUrl} target="_blank" rel="noreferrer"
                 className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary">
                <RadioIcon className="h-3 w-3" /> /radio/{radio.slug}
              </a>
            </div>
          </div>

          {/* Main view tabs (calendar / library) */}
          <nav className="hidden md:flex items-center gap-1 rounded-md border border-border bg-background/60 p-0.5">
            <button onClick={() => setView("schedule")}
              className={cn("flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors",
                view === "schedule" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Calendar className="h-3.5 w-3.5" /> Programmation
            </button>
            <button onClick={() => setView("library")}
              className={cn("flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors",
                view === "library" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Library className="h-3.5 w-3.5" /> Bibliothèque ({tracks.length})
            </button>
          </nav>

          {/* Action buttons (links + broadcast + profile) */}
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setBrandingOpen(true)} title="Profil & couverture de la station">
              <ImageIcon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Profil</span>
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setLinksOpen(true)} title="Liens & intégration">
              <Link2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Liens</span>
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setBroadcastOpen(true)} title="Diffuser vers serveur externe">
              <Share2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Diffuser</span>
            </Button>
          </div>
        </div>

        {/* Mobile view tabs */}
        <div className="md:hidden border-t border-border">
          <div className="container mx-auto flex">
            <button onClick={() => setView("schedule")}
              className={cn("flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-colors",
                view === "schedule" ? "border-primary text-primary" : "border-transparent text-muted-foreground")}>
              <Calendar className="h-3.5 w-3.5" /> Programmation
            </button>
            <button onClick={() => setView("library")}
              className={cn("flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-colors",
                view === "library" ? "border-primary text-primary" : "border-transparent text-muted-foreground")}>
              <Library className="h-3.5 w-3.5" /> Bibliothèque
            </button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-3 py-4 sm:px-4 sm:py-6">
        {/* Conflict banner */}
        {conflictPairs.length > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-[hsl(var(--live-red))]/40 bg-[hsl(var(--live-red))]/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--live-red))]" />
            <div>
              <div className="font-semibold text-[hsl(var(--live-red))]">
                {conflictPairs.length} chevauchement{conflictPairs.length > 1 ? "s" : ""} détecté{conflictPairs.length > 1 ? "s" : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                Cliquez sur les blocs marqués pour les modifier.
              </div>
            </div>
          </div>
        )}

        {/* ─── VIEW: SCHEDULE (calendar) ───────────────────────────── */}
        {view === "schedule" && (
          <section>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">Grille hebdomadaire</h2>
              <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForm(emptyForm()); }}>
                <DialogTrigger asChild>
                  <Button size="sm" onClick={openCreate} className="bg-gradient-brand text-primary-foreground">
                    <Plus className="mr-1 h-4 w-4" /> Programme
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
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
                        <Label htmlFor="title">Titre (optionnel)</Label>
                        <Input id="title" value={form.title}
                          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                          placeholder="Matinale du jour" />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label>Créneaux (jour + heure)</Label>
                        {!form.id && (
                          <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, slots: [...f.slots, { day: "1", start: "09:00", end: "12:00" }] }))}>
                            <Plus className="mr-1 h-3.5 w-3.5" /> Ajouter
                          </Button>
                        )}
                      </div>
                      {form.slots.map((slot, idx) => (
                        <div key={idx} className="grid grid-cols-1 gap-2 rounded-md border border-border bg-background/50 p-2 sm:grid-cols-[1fr,120px,120px,36px]">
                          <Select value={slot.day} onValueChange={(v) => setForm((f) => ({ ...f, slots: f.slots.map((s, i) => i === idx ? { ...s, day: v } : s) }))}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>{DAY_LABELS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                          </Select>
                          <Input type="time" required value={slot.start} onChange={(e) => setForm((f) => ({ ...f, slots: f.slots.map((s, i) => i === idx ? { ...s, start: e.target.value } : s) }))} />
                          <Input type="time" required value={slot.end} onChange={(e) => setForm((f) => ({ ...f, slots: f.slots.map((s, i) => i === idx ? { ...s, end: e.target.value } : s) }))} />
                          {!form.id && form.slots.length > 1 && <Button type="button" variant="ghost" size="icon" onClick={() => setForm((f) => ({ ...f, slots: f.slots.filter((_, i) => i !== idx) }))}><Trash2 className="h-4 w-4" /></Button>}
                        </div>
                      ))}
                    </div>

                    {form.type === "live" ? (
                      <div>
                        <Label htmlFor="stream">URL du stream</Label>
                        <Input id="stream" type="url" required value={form.streamUrl}
                          onChange={(e) => setForm((f) => ({ ...f, streamUrl: e.target.value }))}
                          placeholder="https://…/stream" />
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label>Audio</Label>
                        <div className="flex gap-2 text-xs">
                          <button type="button"
                            onClick={() => setForm((f) => ({ ...f, audioSource: "library" }))}
                            className={cn("flex-1 rounded-md border px-3 py-1.5",
                              form.audioSource === "library" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background")}>
                            Depuis la bibliothèque
                          </button>
                          <button type="button"
                            onClick={() => setForm((f) => ({ ...f, audioSource: "url" }))}
                            className={cn("flex-1 rounded-md border px-3 py-1.5",
                              form.audioSource === "url" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background")}>
                            URL externe
                          </button>
                        </div>
                        {form.audioSource === "library" ? (
                          tracks.length === 0 ? (
                            <p className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground">
                              Bibliothèque vide. Ouvrez Bibliothèque pour uploader des audios.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              <Select value="" onValueChange={(v) => setForm((f) => f.audioTrackIds.includes(v) ? f : ({ ...f, audioTrackIds: [...f.audioTrackIds, v] }))}>
                                <SelectTrigger><SelectValue placeholder="Ajouter une piste depuis Émissions ou Jingles" /></SelectTrigger>
                                <SelectContent>
                                  {schedulableTracks.filter((t) => !form.audioTrackIds.includes(t.id)).map((t) => {
                                    const folder = t.folder_id ? folderById.get(t.folder_id) : null;
                                    return <SelectItem key={t.id} value={t.id}>[{folder?.name ?? (t.kind === "jingle" ? "Jingles" : "Émissions")}] {t.title}</SelectItem>;
                                  })}
                                </SelectContent>
                              </Select>
                              {selectedTracks.length > 0 && (
                                <div className="space-y-1.5 rounded-md border border-border bg-background/50 p-2">
                                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Glissez pour réordonner — lecture séquentielle</p>
                                  {selectedTracks.map((t, idx) => (
                                    <div
                                      key={`${t.id}-${idx}`}
                                      draggable
                                      onDragStart={(e) => { setDragIdx(idx); e.dataTransfer.effectAllowed = "move"; }}
                                      onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverIdx !== idx) setDragOverIdx(idx); }}
                                      onDragLeave={() => { if (dragOverIdx === idx) setDragOverIdx(null); }}
                                      onDrop={(e) => { e.preventDefault(); if (dragIdx !== null) reorderTracks(dragIdx, idx); setDragIdx(null); setDragOverIdx(null); }}
                                      className={cn(
                                        "flex min-w-0 items-center gap-1.5 rounded border px-2 py-1.5 text-xs transition-colors",
                                        dragIdx === idx ? "opacity-40 border-primary" : "border-border/60",
                                        dragOverIdx === idx && dragIdx !== idx ? "border-primary bg-primary/5" : "",
                                      )}
                                    >
                                      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
                                      <span className="min-w-0 flex-1 truncate">{idx + 1}. {t.title}</span>
                                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={idx === 0} onClick={() => reorderTracks(idx, idx - 1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={idx === selectedTracks.length - 1} onClick={() => reorderTracks(idx, idx + 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setForm((f) => ({ ...f, audioTrackIds: f.audioTrackIds.filter((_, i) => i !== idx) }))}><Trash2 className="h-3.5 w-3.5" /></Button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        ) : (
                          <Input type="url" value={form.audioUrl}
                            onChange={(e) => setForm((f) => ({ ...f, audioUrl: e.target.value }))}
                            placeholder="https://…/track.mp3" />
                        )}
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
                      {saving ? "Enregistrement…" : form.id ? "Enregistrer" : "Ajouter le programme"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            <ProgramCalendar
              programs={programs}
              conflictIds={conflictIds}
              onEdit={openEdit}
              onDelete={removeProgram}
              onCreate={openCreateAt}
            />
          </section>
        )}

        {/* ─── VIEW: LIBRARY (myradiomatisme style) ────────────────── */}
        {view === "library" && user && (
          <section className="space-y-4">
            {/* Now playing strip */}
            <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-gradient-card p-3">
              <Music className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Diffusion en cours</div>
                <div className="truncate text-sm font-bold">
                  {engine.state.currentTitle || "—"}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  Source : {engine.state.source === "autodj" ? "Rotation automatique" : engine.state.source === "program" ? (engine.state.active?.title || "Programme") : "Hors antenne"}
                </div>
              </div>
            </div>

            <LibraryManager
              radioId={radio.id}
              radioSlug={radio.slug}
              userId={user.id}
              tracks={tracks}
              onChange={setTracks}
              currentTrackId={engine.state.currentTrackId}
            />
          </section>
        )}
      </main>

      {/* ─── FIXED BOTTOM PLAYER (always visible — RadioDJ style, 40px) ── */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="container mx-auto px-2 py-1 sm:px-3">
          <RadioPlayer slug={radio.slug} radioName={radio.name} showInternalSource compact />
        </div>
      </div>

      {/* ─── LINKS POPUP ─────────────────────────────────────────── */}
      <Dialog open={linksOpen} onOpenChange={setLinksOpen}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Liens & intégration</DialogTitle></DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Lien d'écoute web</div>
              <a href={publicUrl} target="_blank" rel="noreferrer"
                 className="block break-all rounded bg-background p-2 text-xs text-primary hover:underline">{publicUrl}</a>
              <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => copyText(publicUrl, "Lien d'écoute")}>
                <Share2 className="mr-1.5 h-3.5 w-3.5" /> Copier
              </Button>
            </div>

            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="mb-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">Flux 24/7</div>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Pour VLC, autoradio, mobile, ou outils tiers. Diffuse en continu ce qui est en antenne.
              </p>
              {([
                { label: "HLS (.m3u8) — web/mobile", url: streamM3U8 },
                { label: "PLS (.pls) — VLC, players classiques", url: streamPLS },
                { label: "M3U (.m3u) — universel", url: streamM3U },
              ] as const).map((s) => (
                <div key={s.label} className="mb-2 last:mb-0">
                  <div className="mb-1 text-[11px] font-semibold">{s.label}</div>
                  <div className="flex gap-1.5">
                    <a href={s.url} target="_blank" rel="noreferrer"
                       className="block min-w-0 flex-1 truncate rounded bg-background p-2 text-[11px] text-primary hover:underline">{s.url}</a>
                    <Button variant="outline" size="sm" onClick={() => copyText(s.url, s.label.split(" —")[0])}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Code d'intégration</div>
              <label className="mb-2 flex cursor-pointer items-center justify-between rounded border border-border bg-background/50 p-2 text-xs">
                <span className="font-semibold">Lecture automatique</span>
                <input type="checkbox" className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
                  checked={embedAutoplay} onChange={(e) => setEmbedAutoplay(e.target.checked)} />
              </label>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-[10px] leading-relaxed text-foreground/80">
{embedSnippet}
              </pre>
              <Button variant="outline" size="sm" className="mt-2 w-full" onClick={copyEmbed}>
                {copied ? <><Check className="mr-1.5 h-3.5 w-3.5" /> Copié</> : <><Copy className="mr-1.5 h-3.5 w-3.5" /> Copier</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── BROADCAST POPUP ─────────────────────────────────────── */}
      <Dialog open={broadcastOpen} onOpenChange={setBroadcastOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Share2 className="h-4 w-4" /> Diffusion vers serveurs externes</DialogTitle></DialogHeader>
          <BroadcastTargets radioId={radio.id} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RadioDetail;
// keep Settings import used for typing avoidance
void Settings;

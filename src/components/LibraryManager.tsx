import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Music, Upload, Trash2, ArrowUp, ArrowDown, Loader2, X,
  Folder, FolderPlus, Mic, Disc3, Star, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";

type Track = Tables<"tracks">;
type Folder = Tables<"track_folders">;

interface Props {
  radioId: string;
  radioSlug: string;
  userId: string;
  tracks: Track[];
  onChange: (next: Track[]) => void;
  /** ID of the track currently being broadcast — highlighted in the lists. */
  currentTrackId?: string | null;
}

interface UploadItem {
  id: string;
  name: string;
  size: number;
  uploaded: number;       // bytes uploaded
  progress: number;       // 0-100
  status: "pending" | "uploading" | "saving" | "done" | "error";
  error?: string;
  folderId: string;
}

const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,audio/mp4,audio/aac,audio/x-m4a,audio/flac";

/**
 * Upload-progress broadcast: lets the public /radio/:slug page show a
 * discrete indicator while the owner uploads, without coupling components.
 * Same-tab via window event; cross-tab via localStorage event.
 */
const UPLOAD_EVENT = "ir:upload-progress";
function broadcastUploadProgress(slug: string, payload: { active: boolean; pct: number; remaining: number; etaSec: number | null }) {
  try {
    const msg = { slug, ...payload, ts: Date.now() };
    window.dispatchEvent(new CustomEvent(UPLOAD_EVENT, { detail: msg }));
    localStorage.setItem(`ir.upload.${slug}`, JSON.stringify(msg));
  } catch { /* ignore */ }
}

async function probeDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.src = url;
    const done = (v: number) => { URL.revokeObjectURL(url); resolve(v); };
    a.addEventListener("loadedmetadata", () => done(isFinite(a.duration) ? a.duration : 0));
    a.addEventListener("error", () => done(0));
    setTimeout(() => done(0), 10000);
  });
}

async function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
  const { data: sessionRes } = await supabase.auth.getSession();
  const token = sessionRes.session?.access_token ?? (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);
  const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  const url = `${SUPABASE_URL}/storage/v1/object/radio-audio/${encodeURI(path)}`;

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", apikey);
    xhr.setRequestHeader("x-upsert", "false");
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, file.size);
        resolve({ ok: true });
      } else {
        let msg = `HTTP ${xhr.status}`;
        try { const j = JSON.parse(xhr.responseText); msg = j.message || j.error || msg; } catch { /* ignore */ }
        resolve({ ok: false, error: msg });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "Erreur réseau" });
    xhr.send(file);
  });
}

const KIND_META: Record<Folder["kind"], { icon: typeof Disc3; label: string }> = {
  autodj: { icon: Disc3, label: "Auto DJ" },
  shows: { icon: Mic, label: "Émission" },
  jingles: { icon: Music, label: "Jingles" },
  custom: { icon: Folder, label: "Dossier" },
};

export function LibraryManager({ radioId, radioSlug, userId, tracks, onChange, currentTrackId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string>("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const uploadStartRef = useRef<number | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderKind, setNewFolderKind] = useState<Folder["kind"]>("shows");

  const [renameOpen, setRenameOpen] = useState<Folder | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Load folders
  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data } = await supabase.from("track_folders").select("*")
        .eq("radio_id", radioId).order("position");
      if (cancel) return;
      const list = data ?? [];
      setFolders(list);
      const autodj = list.find((f) => f.is_autodj_source) ?? list[0];
      if (autodj) setActiveFolderId((curr) => curr || autodj.id);
    })();
    return () => { cancel = true; };
  }, [radioId]);

  const sortedFolders = useMemo(
    () => [...folders].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)),
    [folders],
  );
  const activeFolder = sortedFolders.find((f) => f.id === activeFolderId) ?? sortedFolders[0] ?? null;

  const tracksByFolder = useMemo(() => {
    const m: Record<string, Track[]> = {};
    for (const t of tracks) {
      const k = t.folder_id ?? "__orphan__";
      (m[k] ??= []).push(t);
    }
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    }
    return m;
  }, [tracks]);

  const visibleTracks = activeFolder ? (tracksByFolder[activeFolder.id] ?? []) : [];
  const isUploading = uploads.some((u) => u.status === "uploading" || u.status === "saving" || u.status === "pending");

  // ---------- Aggregate upload progress + ETA ----------
  const aggregate = useMemo(() => {
    const live = uploads.filter((u) => u.status !== "done" && u.status !== "error");
    if (live.length === 0) return { pct: 0, totalBytes: 0, doneBytes: 0, remaining: 0, etaSec: null as number | null };
    const totalBytes = live.reduce((s, u) => s + u.size, 0);
    const doneBytes = live.reduce((s, u) => s + u.uploaded, 0);
    const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0;
    const elapsed = uploadStartRef.current ? (Date.now() - uploadStartRef.current) / 1000 : 0;
    const speed = elapsed > 0 ? doneBytes / elapsed : 0; // bytes/sec
    const etaSec = speed > 0 && doneBytes < totalBytes ? Math.round((totalBytes - doneBytes) / speed) : null;
    return { pct, totalBytes, doneBytes, remaining: live.length, etaSec };
  }, [uploads]);

  // Broadcast aggregate progress (for the public listener page indicator)
  useEffect(() => {
    if (isUploading) {
      broadcastUploadProgress(radioSlug, {
        active: true, pct: aggregate.pct, remaining: aggregate.remaining, etaSec: aggregate.etaSec,
      });
    } else {
      broadcastUploadProgress(radioSlug, { active: false, pct: 0, remaining: 0, etaSec: null });
    }
  }, [isUploading, aggregate.pct, aggregate.remaining, aggregate.etaSec, radioSlug]);

  const updateUpload = (id: string, patch: Partial<UploadItem>) => {
    setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!activeFolder) { toast.error("Aucun dossier sélectionné"); return; }
    const targetFolder = activeFolder;
    const targetKind: Track["kind"] = targetFolder.kind === "jingles" ? "jingle" : "music";

    const items: UploadItem[] = Array.from(files).map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      uploaded: 0,
      progress: 0,
      status: "pending",
      folderId: targetFolder.id,
    }));
    setUploads((u) => [...u, ...items]);
    if (!uploadStartRef.current) uploadStartRef.current = Date.now();

    const created: Track[] = [];
    const folderTracks = tracksByFolder[targetFolder.id] ?? [];
    let nextPos = (folderTracks[folderTracks.length - 1]?.position ?? 0) + 1;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = files[i];
      if (file.size > MAX_BYTES) {
        updateUpload(item.id, { status: "error", error: "Dépasse 50 Mo", uploaded: 0 });
        toast.error(`${file.name} dépasse 50 Mo`);
        continue;
      }
      try {
        updateUpload(item.id, { status: "uploading" });
        const duration = await probeDuration(file);
        const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
        const safeName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
        const path = `${userId}/${radioId}/${Date.now()}-${safeName}.${ext}`;

        const res = await uploadWithProgress(path, file, (loaded, total) => {
          updateUpload(item.id, { uploaded: loaded, progress: Math.round((loaded / total) * 100) });
        });
        if (res.ok !== true) {
          const errMsg = res.error;
          updateUpload(item.id, { status: "error", error: errMsg });
          toast.error(`${file.name} : ${errMsg}`);
          continue;
        }

        updateUpload(item.id, { status: "saving", progress: 100, uploaded: file.size });
        const { data: pub } = supabase.storage.from("radio-audio").getPublicUrl(path);
        const title = file.name.replace(/\.[^.]+$/, "");
        const { data: row, error: insErr } = await supabase
          .from("tracks")
          .insert({
            radio_id: radioId,
            title,
            audio_url: pub.publicUrl,
            duration_seconds: duration || null,
            position: nextPos++,
            kind: targetKind,
            folder_id: targetFolder.id,
          })
          .select().single();
        if (insErr) {
          updateUpload(item.id, { status: "error", error: insErr.message });
          toast.error(insErr.message);
          continue;
        }
        created.push(row);
        updateUpload(item.id, { status: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "erreur";
        updateUpload(item.id, { status: "error", error: msg });
        toast.error(`Échec ${file.name}: ${msg}`);
      }
    }

    if (created.length) {
      onChange([...tracks, ...created]);
      toast.success(`${created.length} fichier${created.length > 1 ? "s" : ""} ajouté${created.length > 1 ? "s" : ""} à « ${targetFolder.name} »`);
    }
    if (inputRef.current) inputRef.current.value = "";

    setTimeout(() => {
      setUploads((arr) => {
        const next = arr.filter((u) => u.status !== "done");
        if (next.length === 0) uploadStartRef.current = null;
        return next;
      });
    }, 2500);
  };

  const removeTrack = async (t: Track) => {
    if (!confirm(`Supprimer « ${t.title} » ?`)) return;
    try {
      const url = new URL(t.audio_url);
      const idx = url.pathname.indexOf("/radio-audio/");
      if (idx >= 0) {
        const path = decodeURIComponent(url.pathname.slice(idx + "/radio-audio/".length));
        await supabase.storage.from("radio-audio").remove([path]);
      }
    } catch { /* ignore */ }
    const { error } = await supabase.from("tracks").delete().eq("id", t.id);
    if (error) { toast.error(error.message); return; }
    onChange(tracks.filter((x) => x.id !== t.id));
    toast.success("Piste supprimée");
  };

  const move = async (t: Track, dir: -1 | 1) => {
    const sib = tracksByFolder[t.folder_id ?? ""] ?? [];
    const idx = sib.findIndex((x) => x.id === t.id);
    const j = idx + dir;
    if (j < 0 || j >= sib.length) return;
    const other = sib[j];
    const a = { ...t, position: other.position };
    const b = { ...other, position: t.position };
    const { error: e1 } = await supabase.from("tracks").update({ position: a.position }).eq("id", a.id);
    const { error: e2 } = await supabase.from("tracks").update({ position: b.position }).eq("id", b.id);
    if (e1 || e2) { toast.error("Réordonnancement impossible"); return; }
    onChange(tracks.map((x) => x.id === a.id ? a : x.id === b.id ? b : x));
  };

  const moveToFolder = async (t: Track, folderId: string) => {
    if (folderId === t.folder_id) return;
    const target = folders.find((f) => f.id === folderId);
    if (!target) return;
    const newKind: Track["kind"] = target.kind === "jingles" ? "jingle" : "music";
    const sib = tracksByFolder[folderId] ?? [];
    const newPos = (sib[sib.length - 1]?.position ?? 0) + 1;
    const { error } = await supabase.from("tracks")
      .update({ folder_id: folderId, kind: newKind, position: newPos }).eq("id", t.id);
    if (error) { toast.error(error.message); return; }
    onChange(tracks.map((x) => x.id === t.id ? { ...x, folder_id: folderId, kind: newKind, position: newPos } : x));
    toast.success(`Déplacé vers « ${target.name} »`);
  };

  const saveTitle = async (t: Track) => {
    const newTitle = titleDraft.trim();
    setEditingTitleId(null);
    if (!newTitle || newTitle === t.title) return;
    const { error } = await supabase.from("tracks").update({ title: newTitle }).eq("id", t.id);
    if (error) { toast.error(error.message); return; }
    onChange(tracks.map((x) => x.id === t.id ? { ...x, title: newTitle } : x));
  };

  const dismissUpload = (id: string) => setUploads((arr) => arr.filter((u) => u.id !== id));

  // ---------- Folder CRUD ----------
  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const pos = (sortedFolders[sortedFolders.length - 1]?.position ?? 0) + 1;
    const { data, error } = await supabase.from("track_folders")
      .insert({ radio_id: radioId, name, kind: newFolderKind, position: pos, is_autodj_source: false })
      .select().single();
    if (error || !data) { toast.error(error?.message ?? "Erreur"); return; }
    setFolders((f) => [...f, data]);
    setActiveFolderId(data.id);
    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderKind("shows");
    toast.success(`Dossier « ${name} » créé`);
  };

  const setAsAutoDjSource = async (f: Folder) => {
    if (f.is_autodj_source) return;
    // Two-step to satisfy the partial unique index
    const current = folders.find((x) => x.is_autodj_source);
    if (current) {
      const { error: e1 } = await supabase.from("track_folders")
        .update({ is_autodj_source: false }).eq("id", current.id);
      if (e1) { toast.error(e1.message); return; }
    }
    const { error } = await supabase.from("track_folders")
      .update({ is_autodj_source: true }).eq("id", f.id);
    if (error) { toast.error(error.message); return; }
    setFolders((arr) => arr.map((x) => ({ ...x, is_autodj_source: x.id === f.id })));
    toast.success(`« ${f.name} » est maintenant la source de l'Auto DJ`);
  };

  const deleteFolder = async (f: Folder) => {
    const count = (tracksByFolder[f.id] ?? []).length;
    if (count > 0) {
      if (!confirm(`Le dossier « ${f.name} » contient ${count} piste(s). Elles deviendront orphelines (non utilisées par l'Auto DJ). Continuer ?`)) return;
    } else if (!confirm(`Supprimer le dossier « ${f.name} » ?`)) return;
    const { error } = await supabase.from("track_folders").delete().eq("id", f.id);
    if (error) { toast.error(error.message); return; }
    setFolders((arr) => arr.filter((x) => x.id !== f.id));
    onChange(tracks.map((t) => t.folder_id === f.id ? { ...t, folder_id: null } : t));
    if (activeFolderId === f.id && sortedFolders[0]) setActiveFolderId(sortedFolders[0].id);
  };

  const renameFolder = async () => {
    if (!renameOpen) return;
    const name = renameDraft.trim();
    if (!name || name === renameOpen.name) { setRenameOpen(null); return; }
    const { error } = await supabase.from("track_folders").update({ name }).eq("id", renameOpen.id);
    if (error) { toast.error(error.message); return; }
    setFolders((arr) => arr.map((x) => x.id === renameOpen.id ? { ...x, name } : x));
    setRenameOpen(null);
  };

  const totalSec = visibleTracks.reduce((s, t) => s + (t.duration_seconds ?? 0), 0);
  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };
  const fmtBytes = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} Ko` : `${(b / (1024 * 1024)).toFixed(1)} Mo`;
  const fmtEta = (s: number | null) => {
    if (s == null) return "—";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}m ${sec.toString().padStart(2, "0")}s`;
  };

  return (
    <div>
      {/* ---------- Folder tabs ---------- */}
      <Tabs value={activeFolderId} onValueChange={setActiveFolderId} className="w-full">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList className="inline-flex h-auto flex-wrap gap-1 bg-muted/50 p-1">
              {sortedFolders.map((f) => {
                const Icon = KIND_META[f.kind].icon;
                const count = (tracksByFolder[f.id] ?? []).length;
                return (
                  <TabsTrigger key={f.id} value={f.id}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs data-[state=active]:bg-background">
                    <Icon className="h-3.5 w-3.5" />
                    <span className="truncate max-w-[140px]">{f.name}</span>
                    <span className="text-muted-foreground">({count})</span>
                    {f.is_autodj_source && <Star className="h-3 w-3 fill-[hsl(var(--neon-violet))] text-[hsl(var(--neon-violet))]" />}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="shrink-0">
                <FolderPlus className="mr-1 h-3.5 w-3.5" /> Dossier
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Nouveau dossier</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="fname">Nom</Label>
                  <Input id="fname" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Émission du matin" autoFocus />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={newFolderKind} onValueChange={(v) => setNewFolderKind(v as Folder["kind"])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="shows">Émission</SelectItem>
                      <SelectItem value="jingles">Jingles</SelectItem>
                      <SelectItem value="autodj">Musique (Auto DJ)</SelectItem>
                      <SelectItem value="custom">Personnalisé</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Les fichiers du type « Jingles » sont marqués comme jingles. Pour qu'un dossier alimente l'Auto DJ, marquez-le ensuite comme source.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setNewFolderOpen(false)}>Annuler</Button>
                <Button onClick={createFolder} disabled={!newFolderName.trim()} className="bg-gradient-brand text-primary-foreground">
                  Créer
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* ---------- Folder header + actions ---------- */}
        {activeFolder && (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold truncate">{activeFolder.name}</span>
                {activeFolder.is_autodj_source ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--neon-violet))]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--neon-violet))]">
                    <Star className="h-3 w-3 fill-current" /> Source Auto DJ
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setAsAutoDjSource(activeFolder)} className="h-6 px-2 text-[11px]">
                    <Star className="mr-1 h-3 w-3" /> Définir comme source Auto DJ
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => { setRenameDraft(activeFolder.name); setRenameOpen(activeFolder); }} className="h-6 w-6 p-0" title="Renommer">
                  <Pencil className="h-3 w-3" />
                </Button>
                {sortedFolders.length > 1 && !activeFolder.is_autodj_source && (
                  <Button size="sm" variant="ghost" onClick={() => deleteFolder(activeFolder)} className="h-6 w-6 p-0 hover:text-[hsl(var(--live-red))]" title="Supprimer">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {visibleTracks.length} fichier{visibleTracks.length > 1 ? "s" : ""} · {fmt(totalSec)} · MP3, WAV, OGG, M4A, FLAC · 50 Mo max
              </div>
            </div>
            <div className="shrink-0">
              <input ref={inputRef} type="file" accept={ACCEPT} multiple
                className="hidden" onChange={(e) => handleFiles(e.target.files)} />
              <Button size="sm" onClick={() => inputRef.current?.click()} disabled={isUploading}
                className="w-full sm:w-auto bg-gradient-brand text-primary-foreground">
                {isUploading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Upload…</> : <><Upload className="mr-1.5 h-4 w-4" /> Ajouter dans « {activeFolder.name} »</>}
              </Button>
            </div>
          </div>
        )}

        {/* ---------- Aggregate progress ---------- */}
        {isUploading && (
          <div className="mt-4 rounded-xl border border-primary/40 bg-primary/5 p-3">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span>Upload global · {aggregate.remaining} fichier{aggregate.remaining > 1 ? "s" : ""} en cours</span>
              <span className="tabular-nums text-primary">{aggregate.pct}%</span>
            </div>
            <Progress value={aggregate.pct} className="mt-2 h-2" />
            <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
              <span>{fmtBytes(aggregate.doneBytes)} / {fmtBytes(aggregate.totalBytes)}</span>
              <span>Temps restant : {fmtEta(aggregate.etaSec)}</span>
            </div>
          </div>
        )}

        {/* ---------- Per-file progress ---------- */}
        {uploads.length > 0 && (
          <div className="mt-3 space-y-2 rounded-xl border border-border bg-background/40 p-3">
            {uploads.map((u) => {
              const folderName = folders.find((f) => f.id === u.folderId)?.name ?? "?";
              return (
                <div key={u.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{u.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground">→ {folderName}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-muted-foreground tabular-nums">{fmtBytes(u.size)}</span>
                      <span className={`tabular-nums font-semibold ${
                        u.status === "error" ? "text-[hsl(var(--live-red))]"
                          : u.status === "done" ? "text-primary"
                          : "text-foreground"
                      }`}>
                        {u.status === "error" ? "Échec"
                          : u.status === "done" ? "100%"
                          : u.status === "saving" ? "Finalisation…"
                          : `${u.progress}%`}
                      </span>
                      {(u.status === "error" || u.status === "done") && (
                        <button type="button" onClick={() => dismissUpload(u.id)} className="text-muted-foreground hover:text-foreground" aria-label="Fermer">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <Progress value={u.status === "error" ? 100 : u.progress}
                    className={`h-1.5 ${u.status === "error" ? "[&>*]:bg-[hsl(var(--live-red))]" : ""}`} />
                  {u.error && <div className="text-[10px] text-[hsl(var(--live-red))]">{u.error}</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* ---------- Tracks list per folder ---------- */}
        {sortedFolders.map((f) => {
          const list = tracksByFolder[f.id] ?? [];
          return (
            <TabsContent key={f.id} value={f.id} className="mt-4">
              <div className="rounded-xl border border-border bg-gradient-card">
                {list.length === 0 ? (
                  <div className="grid place-items-center px-4 py-10 text-center">
                    <Music className="h-8 w-8 text-muted-foreground" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      Dossier vide. {f.is_autodj_source
                        ? "Ajoutez des fichiers pour alimenter l'Auto DJ."
                        : "Ajoutez des fichiers pour vos émissions/jingles."}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {list.map((t, i) => {
                      const isPlaying = currentTrackId === t.id;
                      return (
                      <li key={t.id} className={`flex items-center gap-2 px-2 py-2 sm:px-4 transition-colors ${isPlaying ? "bg-primary/15 ring-1 ring-primary/40" : ""}`}>
                        <span className="w-5 shrink-0 text-center text-xs sm:w-6">
                          {isPlaying ? (
                            <span className="inline-flex h-3 items-end gap-[1px]">
                              <span className="equalizer-bar !w-[2px]" />
                              <span className="equalizer-bar !w-[2px]" />
                              <span className="equalizer-bar !w-[2px]" />
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{i + 1}</span>
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          {editingTitleId === t.id ? (
                            <Input
                              autoFocus
                              value={titleDraft}
                              onChange={(e) => setTitleDraft(e.target.value)}
                              onBlur={() => saveTitle(t)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveTitle(t); if (e.key === "Escape") setEditingTitleId(null); }}
                              className="h-7 text-sm"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setEditingTitleId(t.id); setTitleDraft(t.title); }}
                              className="block w-full truncate text-left text-sm font-medium hover:text-primary"
                            >
                              {t.title}
                            </button>
                          )}
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>{t.duration_seconds ? fmt(t.duration_seconds) : "—"}</span>
                            {t.kind === "jingle" && (
                              <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[hsl(var(--neon-magenta))]/20 text-[hsl(var(--neon-magenta))]">
                                Jingle
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {sortedFolders.length > 1 && (
                            <Select value={t.folder_id ?? ""} onValueChange={(v) => moveToFolder(t, v)}>
                              <SelectTrigger className="h-7 w-[110px] px-2 text-[11px]">
                                <SelectValue placeholder="Déplacer" />
                              </SelectTrigger>
                              <SelectContent>
                                {sortedFolders.map((ff) => (
                                  <SelectItem key={ff.id} value={ff.id} disabled={ff.id === t.folder_id}>
                                    {ff.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => move(t, -1)} title="Monter" className="h-7 w-7">
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => move(t, 1)} title="Descendre" className="h-7 w-7">
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => removeTrack(t)} title="Supprimer" className="h-7 w-7">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </TabsContent>
          );
        })}
      </Tabs>

      {/* ---------- Rename folder dialog ---------- */}
      <Dialog open={!!renameOpen} onOpenChange={(v) => { if (!v) setRenameOpen(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Renommer le dossier</DialogTitle></DialogHeader>
          <Input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") renameFolder(); }} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(null)}>Annuler</Button>
            <Button onClick={renameFolder} className="bg-gradient-brand text-primary-foreground">Enregistrer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

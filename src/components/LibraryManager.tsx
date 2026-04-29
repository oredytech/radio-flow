import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Music, Upload, Trash2, ArrowUp, ArrowDown, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";

type Track = Tables<"tracks">;

interface Props {
  radioId: string;
  userId: string;
  tracks: Track[];
  onChange: (next: Track[]) => void;
}

interface UploadItem {
  id: string;
  name: string;
  size: number;
  progress: number; // 0-100
  status: "pending" | "uploading" | "saving" | "done" | "error";
  error?: string;
}

const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,audio/mp4,audio/aac,audio/x-m4a,audio/flac";

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

// Upload via XHR to capture progress events. Storage REST endpoint.
async function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (pct: number) => void,
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
      if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
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

export function LibraryManager({ radioId, userId, tracks, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  const sorted = [...tracks].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  const isUploading = uploads.some((u) => u.status === "uploading" || u.status === "saving" || u.status === "pending");

  const updateUpload = (id: string, patch: Partial<UploadItem>) => {
    setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const items: UploadItem[] = Array.from(files).map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      progress: 0,
      status: "pending",
    }));
    setUploads((u) => [...u, ...items]);

    const created: Track[] = [];
    let nextPos = (sorted[sorted.length - 1]?.position ?? 0) + 1;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = files[i];
      if (file.size > MAX_BYTES) {
        updateUpload(item.id, { status: "error", error: "Dépasse 50 Mo" });
        toast.error(`${file.name} dépasse 50 Mo`);
        continue;
      }
      try {
        updateUpload(item.id, { status: "uploading" });
        const duration = await probeDuration(file);
        const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
        const safeName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
        const path = `${userId}/${radioId}/${Date.now()}-${safeName}.${ext}`;

        const res = await uploadWithProgress(path, file, (pct) => updateUpload(item.id, { progress: pct }));
        if (!res.ok) {
          updateUpload(item.id, { status: "error", error: res.error });
          toast.error(`${file.name} : ${res.error}`);
          continue;
        }

        updateUpload(item.id, { status: "saving", progress: 100 });
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
            kind: "music",
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
      toast.success(`${created.length} piste${created.length > 1 ? "s" : ""} ajoutée${created.length > 1 ? "s" : ""}`);
    }
    if (inputRef.current) inputRef.current.value = "";

    // Auto clean done items after 2.5s
    setTimeout(() => {
      setUploads((arr) => arr.filter((u) => u.status !== "done"));
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
    const idx = sorted.findIndex((x) => x.id === t.id);
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const other = sorted[j];
    const a = { ...t, position: other.position };
    const b = { ...other, position: t.position };
    const { error: e1 } = await supabase.from("tracks").update({ position: a.position }).eq("id", a.id);
    const { error: e2 } = await supabase.from("tracks").update({ position: b.position }).eq("id", b.id);
    if (e1 || e2) { toast.error("Réordonnancement impossible"); return; }
    onChange(tracks.map((x) => x.id === a.id ? a : x.id === b.id ? b : x));
  };

  const saveTitle = async (t: Track) => {
    const newTitle = titleDraft.trim();
    setEditingTitleId(null);
    if (!newTitle || newTitle === t.title) return;
    const { error } = await supabase.from("tracks").update({ title: newTitle }).eq("id", t.id);
    if (error) { toast.error(error.message); return; }
    onChange(tracks.map((x) => x.id === t.id ? { ...x, title: newTitle } : x));
  };

  const toggleKind = async (t: Track) => {
    const kind = t.kind === "jingle" ? "music" : "jingle";
    const { error } = await supabase.from("tracks").update({ kind }).eq("id", t.id);
    if (error) { toast.error(error.message); return; }
    onChange(tracks.map((x) => x.id === t.id ? { ...x, kind } : x));
  };

  const dismissUpload = (id: string) => setUploads((arr) => arr.filter((u) => u.id !== id));

  const totalSec = sorted.filter((t) => t.kind !== "jingle").reduce((s, t) => s + (t.duration_seconds ?? 0), 0);
  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };
  const fmtBytes = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} Ko` : `${(b / (1024 * 1024)).toFixed(1)} Mo`;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">
            {sorted.length} piste{sorted.length > 1 ? "s" : ""} · rotation Auto DJ {fmt(totalSec)}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            MP3, WAV, OGG, M4A, FLAC · 50 Mo max
          </div>
        </div>
        <div className="shrink-0">
          <input ref={inputRef} type="file" accept={ACCEPT} multiple
            className="hidden" onChange={(e) => handleFiles(e.target.files)} />
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={isUploading}
            className="w-full sm:w-auto bg-gradient-brand text-primary-foreground">
            {isUploading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Upload…</> : <><Upload className="mr-1.5 h-4 w-4" /> Ajouter audios</>}
          </Button>
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="mt-4 space-y-2 rounded-xl border border-border bg-background/40 p-3">
          {uploads.map((u) => (
            <div key={u.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0 flex-1 truncate font-medium">{u.name}</div>
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
              <Progress value={u.status === "error" ? 100 : u.progress} className={`h-1.5 ${u.status === "error" ? "[&>*]:bg-[hsl(var(--live-red))]" : ""}`} />
              {u.error && <div className="text-[10px] text-[hsl(var(--live-red))]">{u.error}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-border bg-gradient-card">
        {sorted.length === 0 ? (
          <div className="grid place-items-center px-4 py-10 text-center">
            <Music className="h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Bibliothèque vide. Ajoutez des audios pour activer l'Auto DJ.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map((t, i) => (
              <li key={t.id} className="flex items-center gap-2 px-2 py-2 sm:px-4">
                <span className="w-5 shrink-0 text-center text-xs text-muted-foreground sm:w-6">{i + 1}</span>
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
                    <button
                      type="button"
                      onClick={() => toggleKind(t)}
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider transition ${
                        t.kind === "jingle"
                          ? "bg-[hsl(var(--neon-magenta))]/20 text-[hsl(var(--neon-magenta))]"
                          : "bg-secondary text-foreground hover:bg-muted"
                      }`}
                    >
                      {t.kind === "jingle" ? "Jingle" : "Musique"}
                    </button>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
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
            ))}
          </ul>
        )}
      </div>
      <Label className="hidden">.</Label>
    </div>
  );
}

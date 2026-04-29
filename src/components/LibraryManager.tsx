import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Music, Upload, Trash2, ArrowUp, ArrowDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";

type Track = Tables<"tracks">;

interface Props {
  radioId: string;
  userId: string;
  tracks: Track[];
  onChange: (next: Track[]) => void;
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

export function LibraryManager({ radioId, userId, tracks, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  const sorted = [...tracks].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const created: Track[] = [];
    let nextPos = (sorted[sorted.length - 1]?.position ?? 0) + 1;

    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} dépasse 50 Mo`);
        continue;
      }
      try {
        const duration = await probeDuration(file);
        const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
        const safeName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
        const path = `${userId}/${radioId}/${Date.now()}-${safeName}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("radio-audio")
          .upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) { toast.error(`${file.name} : ${upErr.message}`); continue; }
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
        if (insErr) { toast.error(insErr.message); continue; }
        created.push(row);
      } catch (e) {
        toast.error(`Échec ${file.name}: ${e instanceof Error ? e.message : "erreur"}`);
      }
    }

    setUploading(false);
    if (created.length) {
      onChange([...tracks, ...created]);
      toast.success(`${created.length} piste${created.length > 1 ? "s" : ""} ajoutée${created.length > 1 ? "s" : ""}`);
    }
    if (inputRef.current) inputRef.current.value = "";
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

  const totalSec = sorted.filter((t) => t.kind !== "jingle").reduce((s, t) => s + (t.duration_seconds ?? 0), 0);
  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm text-muted-foreground">
            {sorted.length} piste{sorted.length > 1 ? "s" : ""} · rotation Auto DJ {fmt(totalSec)}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            MP3, WAV, OGG, M4A, FLAC · 50 Mo max
          </div>
        </div>
        <div>
          <input ref={inputRef} type="file" accept={ACCEPT} multiple
            className="hidden" onChange={(e) => handleFiles(e.target.files)} />
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}
            className="bg-gradient-brand text-primary-foreground">
            {uploading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Upload…</> : <><Upload className="mr-1.5 h-4 w-4" /> Ajouter audios</>}
          </Button>
        </div>
      </div>

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
              <li key={t.id} className="flex items-center gap-2 px-3 py-2 sm:px-4">
                <span className="w-6 text-center text-xs text-muted-foreground">{i + 1}</span>
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
                      className="truncate text-left text-sm font-medium hover:text-primary"
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
                <div className="flex items-center gap-0.5">
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

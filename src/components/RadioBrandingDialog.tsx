import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  radio: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    cover_url?: string | null;
    avatar_url?: string | null;
  };
  onUpdated: (patch: { description?: string | null; cover_url?: string | null; avatar_url?: string | null }) => void;
}

const BUCKET = "radio-audio";

export function RadioBrandingDialog({ open, onOpenChange, radio, onUpdated }: Props) {
  const [description, setDescription] = useState(radio.description ?? "");
  const [cover, setCover] = useState<string | null>(radio.cover_url ?? null);
  const [avatar, setAvatar] = useState<string | null>(radio.avatar_url ?? null);
  const [busy, setBusy] = useState<"cover" | "avatar" | "save" | null>(null);

  useEffect(() => {
    if (open) {
      setDescription(radio.description ?? "");
      setCover(radio.cover_url ?? null);
      setAvatar(radio.avatar_url ?? null);
    }
  }, [open, radio]);

  const uploadImage = async (file: File, kind: "cover" | "avatar") => {
    if (!file.type.startsWith("image/")) { toast.error("Image requise"); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error("Image trop lourde (max 5 Mo)"); return; }
    setBusy(kind);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${radio.slug}/branding/${kind}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
        cacheControl: "3600", upsert: true, contentType: file.type,
      });
      if (error) throw error;
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      if (kind === "cover") setCover(pub.publicUrl);
      else setAvatar(pub.publicUrl);
      toast.success(kind === "cover" ? "Couverture chargée" : "Avatar chargé");
    } catch (e) {
      toast.error((e as Error).message || "Échec de l'envoi");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    const patch = {
      description: description.trim() || null,
      cover_url: cover,
      avatar_url: avatar,
    };
    const { error } = await supabase.from("radios").update(patch).eq("id", radio.id);
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    onUpdated(patch);
    toast.success("Profil mis à jour");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader><DialogTitle>Profil de la station</DialogTitle></DialogHeader>

        {/* Cover preview */}
        <div className="space-y-1.5">
          <Label>Image de couverture</Label>
          <div
            className="relative h-36 w-full overflow-hidden rounded-lg border border-border bg-secondary"
            style={cover ? { backgroundImage: `url(${cover})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: "var(--gradient-brand)" }}
          >
            {cover && (
              <button
                type="button" onClick={() => setCover(null)}
                className="absolute right-2 top-2 rounded-full bg-background/80 p-1.5 text-muted-foreground hover:text-destructive"
                title="Retirer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
            {busy === "cover" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
            Choisir une image (max 5 Mo)
            <input type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f, "cover"); e.target.value = ""; }} />
          </label>
        </div>

        {/* Avatar preview */}
        <div className="space-y-1.5">
          <Label>Avatar</Label>
          <div className="flex items-center gap-3">
            <div className="h-20 w-20 overflow-hidden rounded-xl border border-border bg-card">
              {avatar ? (
                <img src={avatar} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center bg-gradient-brand text-xl font-extrabold text-primary-foreground">
                  {radio.name.slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
                {busy === "avatar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                Choisir un avatar
                <input type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f, "avatar"); e.target.value = ""; }} />
              </label>
              {avatar && (
                <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={() => setAvatar(null)}>
                  <Trash2 className="h-3 w-3" /> Retirer
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="desc">Description</Label>
          <Textarea id="desc" rows={4} value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Présentez votre station, votre équipe, votre style musical…" />
        </div>

        {/* Save / cancel */}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={save} disabled={busy === "save"} className="bg-gradient-brand text-primary-foreground">
            {busy === "save" ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Enregistrement…</> : "Enregistrer"}
          </Button>
        </div>

        {/* Public preview link */}
        <div className="mt-2 text-center text-[11px] text-muted-foreground">
          Visible sur <a href={`/radio/${radio.slug}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">/radio/{radio.slug}</a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

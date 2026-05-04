import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Radio as RadioIcon, Pencil, Loader2, Play, Square, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface Target {
  id: string;
  radio_id: string;
  name: string;
  protocol: "icecast" | "shoutcast";
  host: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  bitrate_kbps: number;
  use_tls: boolean;
  enabled: boolean;
  last_started_at: string | null;
  last_error: string | null;
}

interface Props {
  radioId: string;
}

const empty = (radioId: string): Omit<Target, "id" | "last_started_at" | "last_error"> => ({
  radio_id: radioId, name: "Mon serveur", protocol: "icecast",
  host: "", port: 8000, mount: "/stream",
  username: "source", password: "", bitrate_kbps: 128, use_tls: false, enabled: true,
});

export function BroadcastTargets({ radioId }: Props) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Target> | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeRelay, setActiveRelay] = useState<string | null>(null);
  const [activeAbort, setActiveAbort] = useState<AbortController | null>(null);

  const reload = async () => {
    const { data } = await supabase.from("broadcast_targets").select("*").eq("radio_id", radioId).order("created_at");
    setTargets((data ?? []) as Target[]);
  };
  useEffect(() => { reload(); }, [radioId]); // eslint-disable-line

  const openNew = () => { setEditing(empty(radioId)); setOpen(true); };
  const openEdit = (t: Target) => { setEditing(t); setOpen(true); };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const payload = { ...editing, radio_id: radioId };
    if (editing.id) {
      const { error } = await supabase.from("broadcast_targets").update(payload).eq("id", editing.id);
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      toast.success("Cible mise à jour");
    } else {
      const { error } = await supabase.from("broadcast_targets").insert(payload as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      toast.success("Cible ajoutée");
    }
    setOpen(false); setEditing(null); await reload();
  };

  const remove = async (id: string) => {
    if (!confirm("Supprimer cette cible de diffusion ?")) return;
    const { error } = await supabase.from("broadcast_targets").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await reload();
  };

  const test = async (t: Target) => {
    setBusyId(t.id);
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token;
    try {
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/broadcast-relay/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ targetId: t.id }),
      });
      const j = await r.json();
      if (j.ok) toast.success(`Connexion OK (HTTP ${j.status})`);
      else toast.error(`Échec : ${j.error || j.body || "—"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
    setBusyId(null);
  };

  const startRelay = async (t: Target) => {
    if (activeRelay) { toast.error("Un relai est déjà en cours"); return; }
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token;
    const ctrl = new AbortController();
    setActiveRelay(t.id); setActiveAbort(ctrl);
    toast.info(`Diffusion vers « ${t.name} » démarrée. Limitée par la durée des fonctions edge.`);
    try {
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/broadcast-relay/start`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ targetId: t.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) toast.success(`Relai terminé (${Math.round((j.bytes ?? 0)/1024)} Ko envoyés)`);
      else toast.error(`Relai stoppé : ${j.error || "—"}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error(e instanceof Error ? e.message : "Erreur");
    }
    setActiveRelay(null); setActiveAbort(null); await reload();
  };

  const stopRelay = () => {
    activeAbort?.abort();
    setActiveRelay(null); setActiveAbort(null);
    toast.success("Relai arrêté");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Diffusion vers serveurs externes</div>
          <p className="text-[11px] text-muted-foreground">Type BUTT — Icecast 2.4+ / Shoutcast v2 (HTTP PUT).</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button size="sm" onClick={openNew} className="bg-gradient-brand text-primary-foreground">
              <Plus className="mr-1 h-3.5 w-3.5" /> Cible
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{editing?.id ? "Modifier la cible" : "Nouvelle cible de diffusion"}</DialogTitle></DialogHeader>
            {editing && (
              <div className="space-y-3">
                <div><Label>Nom</Label><Input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Protocole</Label>
                    <Select value={editing.protocol ?? "icecast"} onValueChange={(v) => setEditing({ ...editing, protocol: v as any })}>{/* eslint-disable-line @typescript-eslint/no-explicit-any */}
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="icecast">Icecast 2.4+</SelectItem>
                        <SelectItem value="shoutcast">Shoutcast v2</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label>Bitrate (kbps)</Label>
                      <Input type="number" value={editing.bitrate_kbps ?? 128} onChange={(e) => setEditing({ ...editing, bitrate_kbps: parseInt(e.target.value) || 128 })} />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-[1fr,90px] gap-2">
                  <div><Label>Hôte</Label><Input value={editing.host ?? ""} onChange={(e) => setEditing({ ...editing, host: e.target.value })} placeholder="stream.exemple.com" /></div>
                  <div><Label>Port</Label><Input type="number" value={editing.port ?? 8000} onChange={(e) => setEditing({ ...editing, port: parseInt(e.target.value) || 8000 })} /></div>
                </div>
                <div><Label>Mount</Label><Input value={editing.mount ?? ""} onChange={(e) => setEditing({ ...editing, mount: e.target.value })} placeholder="/stream" /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><Label>Utilisateur</Label><Input value={editing.username ?? ""} onChange={(e) => setEditing({ ...editing, username: e.target.value })} /></div>
                  <div><Label>Mot de passe</Label><Input type="password" value={editing.password ?? ""} onChange={(e) => setEditing({ ...editing, password: e.target.value })} /></div>
                </div>
                <label className="flex cursor-pointer items-center justify-between rounded border border-border bg-background/50 px-3 py-2 text-sm">
                  <span>HTTPS / TLS</span>
                  <Switch checked={!!editing.use_tls} onCheckedChange={(v) => setEditing({ ...editing, use_tls: v })} />
                </label>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
              <Button onClick={save} disabled={saving} className="bg-gradient-brand text-primary-foreground">
                {saving ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {targets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-background/30 p-4 text-center text-xs text-muted-foreground">
          Aucune cible. Ajoutez votre serveur Icecast/Shoutcast pour relayer la diffusion.
        </div>
      ) : (
        <ul className="space-y-2">
          {targets.map((t) => {
            const live = activeRelay === t.id;
            return (
              <li key={t.id} className="rounded-lg border border-border bg-background/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-semibold">
                      <RadioIcon className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="truncate">{t.name}</span>
                      {live && <span className="live-pulse rounded-full bg-[hsl(var(--live-red))] px-1.5 py-0.5 text-[9px] font-bold text-white">LIVE</span>}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {t.protocol} · {t.use_tls ? "https" : "http"}://{t.host}:{t.port}{t.mount} · {t.bitrate_kbps}k
                    </div>
                    {t.last_error && (
                      <div className="mt-1 flex items-start gap-1 text-[10px] text-[hsl(var(--live-red))]">
                        <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                        <span className="truncate">{t.last_error}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {live ? (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-[hsl(var(--live-red))]" onClick={stopRelay} title="Arrêter">
                        <Square className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startRelay(t)} disabled={!!activeRelay} title="Démarrer le relai">
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => test(t)} disabled={busyId === t.id} title="Tester la connexion">
                      {busyId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="text-[10px] font-bold">TEST</span>}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(t)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(t.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        ⚠ Le relai via fonction edge est limité dans le temps (quelques minutes par session). Pour un 24/7 fiable, utilisez un outil tiers (BUTT, Liquidsoap, ezstream) pointé sur votre flux HLS/M3U interne.
      </p>
    </div>
  );
}

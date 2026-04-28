import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ArrowLeft, Plus, Trash2, Radio as RadioIcon, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { RadioPlayer } from "@/components/RadioPlayer";
import { DAY_LABELS } from "@/lib/schedule";
import type { Tables } from "@/integrations/supabase/types";

type RadioRow = Tables<"radios">;
type Program = Tables<"programs">;

const RadioDetail = () => {
  const { id } = useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [radio, setRadio] = useState<RadioRow | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form state
  const [type, setType] = useState<"playlist" | "live">("playlist");
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("1");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("12:00");
  const [audioUrl, setAudioUrl] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!loading && !user) navigate("/auth"); }, [user, loading, navigate]);

  useEffect(() => {
    if (!id) return;
    supabase.from("radios").select("*").eq("id", id).maybeSingle()
      .then(({ data }) => setRadio(data));
    supabase.from("programs").select("*").eq("radio_id", id)
      .order("day_of_week").order("start_time")
      .then(({ data }) => setPrograms(data ?? []));
  }, [id]);

  const embedUrl = `${window.location.origin}/embed/${radio?.slug ?? ""}`;
  const embedSnippet = `<iframe src="${embedUrl}" width="100%" height="120" frameborder="0" allow="autoplay"></iframe>`;

  const copyEmbed = async () => {
    await navigator.clipboard.writeText(embedSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success("Embed code copied");
  };

  const addProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!radio) return;
    setSaving(true);
    const { data, error } = await supabase.from("programs").insert({
      radio_id: radio.id,
      type, title: title || null,
      day_of_week: Number(day),
      start_time: start, end_time: end,
      audio_url: type === "playlist" ? audioUrl : null,
      stream_url: type === "live" ? streamUrl : null,
    }).select().single();
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    setPrograms((p) => [...p, data].sort((a, b) =>
      a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)));
    toast.success("Program added");
    setOpen(false);
    setTitle(""); setAudioUrl(""); setStreamUrl("");
  };

  const removeProgram = async (pid: string) => {
    const { error } = await supabase.from("programs").delete().eq("id", pid);
    if (error) { toast.error(error.message); return; }
    setPrograms((p) => p.filter((x) => x.id !== pid));
  };

  const grouped = useMemo(() => {
    const m: Record<number, Program[]> = {};
    for (const p of programs) (m[p.day_of_week] ??= []).push(p);
    return m;
  }, [programs]);

  if (!radio) return <div className="grid min-h-screen place-items-center text-muted-foreground">Loading…</div>;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="container mx-auto flex items-center justify-between py-4">
          <Link to="/dashboard" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RadioIcon className="h-3.5 w-3.5" /> /{radio.slug}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold">{radio.name}</h1>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr,360px]">
          {/* Schedule */}
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Weekly schedule</h2>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-gradient-brand text-primary-foreground">
                    <Plus className="mr-1.5 h-4 w-4" /> Program
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>New program</DialogTitle></DialogHeader>
                  <form onSubmit={addProgram} className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Type</Label>
                        <Select value={type} onValueChange={(v) => setType(v as "playlist" | "live")}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="playlist">Playlist (synced)</SelectItem>
                            <SelectItem value="live">Live stream</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Day</Label>
                        <Select value={day} onValueChange={setDay}>
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
                      <Label htmlFor="title">Title (optional)</Label>
                      <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Morning Drive" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="start">Start</Label>
                        <Input id="start" type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
                      </div>
                      <div>
                        <Label htmlFor="end">End</Label>
                        <Input id="end" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />
                      </div>
                    </div>
                    {type === "playlist" ? (
                      <div>
                        <Label htmlFor="audio">Audio URL</Label>
                        <Input id="audio" type="url" required value={audioUrl}
                          onChange={(e) => setAudioUrl(e.target.value)} placeholder="https://…/track.mp3" />
                        <p className="mt-1 text-xs text-muted-foreground">Played in sync from server time. Loops within window.</p>
                      </div>
                    ) : (
                      <div>
                        <Label htmlFor="stream">Stream URL</Label>
                        <Input id="stream" type="url" required value={streamUrl}
                          onChange={(e) => setStreamUrl(e.target.value)} placeholder="https://…/stream" />
                        <p className="mt-1 text-xs text-muted-foreground">Overrides any playlist in this window.</p>
                      </div>
                    )}
                    <Button type="submit" disabled={saving} className="w-full bg-gradient-brand text-primary-foreground">
                      {saving ? "Saving…" : "Add program"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            <div className="mt-4 space-y-3">
              {DAY_LABELS.map((d, i) => (
                <div key={i} className="rounded-xl border border-border bg-gradient-card p-4">
                  <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">{d}</div>
                  {(grouped[i] ?? []).length === 0 ? (
                    <div className="text-sm text-muted-foreground/70">No programs</div>
                  ) : (
                    <ul className="divide-y divide-border">
                      {grouped[i].map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                p.type === "live"
                                  ? "bg-[hsl(var(--live-red))] text-white"
                                  : "bg-secondary text-foreground"
                              }`}>{p.type}</span>
                              <span className="truncate text-sm font-medium">{p.title || "(untitled)"}</span>
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {p.start_time.slice(0,5)} – {p.end_time.slice(0,5)} · {p.audio_url || p.stream_url}
                            </div>
                          </div>
                          <Button variant="ghost" size="icon" onClick={() => removeProgram(p.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Sidebar: Live preview + embed */}
          <aside className="space-y-4">
            <div>
              <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Live preview</div>
              <RadioPlayer slug={radio.slug} radioName={radio.name} />
            </div>
            <div className="rounded-xl border border-border bg-gradient-card p-4">
              <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Embed code</div>
              <pre className="overflow-x-auto rounded-md bg-background p-3 text-[11px] leading-relaxed text-foreground/80">
{embedSnippet}
              </pre>
              <Button variant="outline" size="sm" className="mt-2 w-full" onClick={copyEmbed}>
                {copied ? <><Check className="mr-1.5 h-3.5 w-3.5" /> Copied</> : <><Copy className="mr-1.5 h-3.5 w-3.5" /> Copy</>}
              </Button>
              <a href={`/embed/${radio.slug}`} target="_blank" rel="noreferrer"
                className="mt-2 block text-center text-xs text-primary hover:underline">
                Open embed page →
              </a>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default RadioDetail;

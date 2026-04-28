import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Radio, Plus, LogOut, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";
import { useNowPlaying, NowPlayingBadge } from "@/components/NowPlaying";

type RadioRow = Tables<"radios">;

const slugify = (s: string) => s.toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);

const Dashboard = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [radios, setRadios] = useState<RadioRow[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate("/auth", { replace: true });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (!user) return;
    supabase.from("radios").select("*").eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setRadios(data ?? []));
  }, [user]);

  const radioIds = useMemo(() => radios.map((r) => r.id), [radios]);
  const { items: nowPlaying, loading: nowLoading } = useNowPlaying({ radioIds });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCreating(true);
    const finalSlug = slug || slugify(name);
    const { data, error } = await supabase.from("radios")
      .insert({ name, slug: finalSlug, user_id: user.id })
      .select().single();
    setCreating(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Radio créée");
    setRadios((r) => [data, ...r]);
    setOpen(false);
    setName(""); setSlug("");
    navigate(`/dashboard/${data.id}`);
  };

  const signOut = async () => { await supabase.auth.signOut(); navigate("/"); };

  if (loading) return null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="container mx-auto flex items-center justify-between py-4">
          <Link to="/" className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-brand shadow-glow">
              <Radio className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-bold">Illusion<span className="text-gradient-brand">Radio</span></span>
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-4 w-4" /></Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Mes stations</h1>
            <p className="text-sm text-muted-foreground">Programmez, passez en direct, intégrez partout.</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-brand text-primary-foreground shadow-glow">
                <Plus className="mr-2 h-4 w-4" /> Nouvelle station
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Créer une station</DialogTitle></DialogHeader>
              <form onSubmit={create} className="space-y-4">
                <div>
                  <Label htmlFor="name">Nom</Label>
                  <Input id="name" required value={name}
                    onChange={(e) => { setName(e.target.value); if (!slug) setSlug(slugify(e.target.value)); }} />
                </div>
                <div>
                  <Label htmlFor="slug">Slug (identifiant URL)</Label>
                  <Input id="slug" required value={slug} onChange={(e) => setSlug(slugify(e.target.value))} />
                  <p className="mt-1 text-xs text-muted-foreground">/radio/{slug || "votre-slug"}</p>
                </div>
                <Button type="submit" disabled={creating} className="w-full bg-gradient-brand text-primary-foreground">
                  {creating ? "Création…" : "Créer"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {radios.length === 0 ? (
          <div className="mt-12 rounded-xl border border-dashed border-border bg-card/50 p-12 text-center">
            <Radio className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-3 text-muted-foreground">Aucune station pour l'instant. Créez la première.</p>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {radios.map((r) => {
              const active = nowPlaying[r.id];
              return (
                <Link key={r.id} to={`/dashboard/${r.id}`}
                  className="group rounded-xl border border-border bg-gradient-card p-5 shadow-elevated transition hover:border-primary/60 hover:shadow-glow">
                  <div className="flex items-start justify-between">
                    <div className="grid h-10 w-10 place-items-center rounded-lg bg-secondary">
                      <Radio className="h-5 w-5 text-primary" />
                    </div>
                    <ExternalLink className="h-4 w-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                  </div>
                  <div className="mt-4 text-lg font-semibold">{r.name}</div>
                  <div className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">/{r.slug}</div>
                  <div className="mt-3 flex items-center gap-2">
                    <NowPlayingBadge active={active} loading={nowLoading} />
                    {active && (
                      <span className="truncate text-xs text-muted-foreground">
                        {active.title || (active.type === "live" ? "Émission en direct" : "Lecture")}
                        <span className="ml-1 opacity-70">· {active.start_time.slice(0,5)}–{active.end_time.slice(0,5)}</span>
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default Dashboard;

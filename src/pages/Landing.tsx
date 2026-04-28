import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Radio, Zap, Globe, Clock } from "lucide-react";
import { useAuth } from "@/lib/useAuth";

const Landing = () => {
  const { user } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="container mx-auto flex items-center justify-between py-6">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-brand shadow-glow">
            <Radio className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold tracking-tight">Illusion<span className="text-gradient-brand">Radio</span></span>
        </Link>
        <nav className="flex items-center gap-3">
          {user ? (
            <Button asChild variant="default"><Link to="/dashboard">Tableau de bord</Link></Button>
          ) : (
            <>
              <Button asChild variant="ghost"><Link to="/auth">Se connecter</Link></Button>
              <Button asChild><Link to="/auth?mode=signup">Lancer ma radio</Link></Button>
            </>
          )}
        </nav>
      </header>

      <main className="container mx-auto px-4 pb-24 pt-12">
        <section className="mx-auto max-w-4xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted-foreground backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--live-red))] live-pulse" />
            Moteur de diffusion synchronisé
          </span>
          <h1 className="mt-6 text-5xl font-extrabold leading-tight tracking-tight sm:text-7xl">
            Une vraie <span className="text-gradient-brand">station de radio</span>,
            pas une playlist.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Programmez vos émissions, basculez en direct instantanément, et intégrez votre radio partout.
            Tous les auditeurs entendent la même chose au même moment — synchronisés au temps serveur, avec correction de dérive en continu.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="bg-gradient-brand text-primary-foreground shadow-glow hover:opacity-90">
              <Link to={user ? "/dashboard" : "/auth?mode=signup"}>Lancer ma station</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/auth">Se connecter</Link>
            </Button>
          </div>
        </section>

        <section className="mx-auto mt-24 grid max-w-5xl gap-4 sm:grid-cols-3">
          {[
            { icon: Clock, title: "Sync au temps serveur", body: "Tous les clients alignés sur une horloge unique, avec correction de dérive sub-seconde." },
            { icon: Zap, title: "Bascule en direct", body: "Passez en live avec une URL de stream — la playlist s'efface, le voyant LIVE s'allume." },
            { icon: Globe, title: "Intégration partout", body: "Une iframe à coller sur n'importe quel site. Thème, autoplay, mode minimal." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-border bg-gradient-card p-6 shadow-elevated">
              <Icon className="h-6 w-6 text-primary" />
              <div className="mt-3 text-base font-semibold">{title}</div>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
};

export default Landing;

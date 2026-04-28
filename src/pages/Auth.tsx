import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/useAuth";

const Auth = () => {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">(
    params.get("mode") === "signup" ? "signup" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => { if (user) navigate("/dashboard", { replace: true }); }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: {
            emailRedirectTo: window.location.origin + "/dashboard",
            data: { display_name: displayName || email.split("@")[0] },
          },
        });
        if (error) throw error;
        toast.success("Compte créé ! Vous êtes connecté.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Bon retour parmi nous");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-gradient-card p-8 shadow-elevated">
        <Link to="/" className="mb-6 flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-brand shadow-glow">
            <Radio className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold">Illusion<span className="text-gradient-brand">Radio</span></span>
        </Link>
        <h1 className="text-2xl font-bold">{mode === "signup" ? "Lancer ma radio" : "Bon retour"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signup" ? "Créez votre station en quelques secondes." : "Connectez-vous pour gérer vos stations."}
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {mode === "signup" && (
            <div>
              <Label htmlFor="display_name">Nom d'affichage</Label>
              <Input id="display_name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="DJ Nova" />
            </div>
          )}
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="password">Mot de passe</Label>
            <Input id="password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button type="submit" disabled={loading} className="w-full bg-gradient-brand text-primary-foreground shadow-glow">
            {loading ? "Veuillez patienter…" : mode === "signup" ? "Créer mon compte" : "Se connecter"}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => setMode((m) => (m === "signup" ? "signin" : "signup"))}
          className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "signup" ? "Déjà un compte ? Se connecter" : "Nouveau ? Créer un compte"}
        </button>
      </div>
    </div>
  );
};

export default Auth;

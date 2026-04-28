import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { RadioPlayer } from "@/components/RadioPlayer";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";

const Embed = () => {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const theme = (params.get("theme") === "light" ? "light" : "dark") as "dark" | "light";
  const minimal = params.get("minimal") === "1";
  const autoplay = params.get("autoplay") === "1";
  const [name, setName] = useState<string | undefined>();

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    supabase.from("radios").select("name").eq("slug", slug).maybeSingle()
      .then(({ data }) => setName(data?.name));
  }, [slug]);

  return (
    <div className="h-screen w-screen p-2">
      <RadioPlayer slug={slug} radioName={name} theme={theme} minimal={minimal} autoplay={autoplay} />
    </div>
  );
};

export default Embed;

CREATE OR REPLACE FUNCTION public.set_updated_at_now()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.broadcast_targets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  radio_id UUID NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'icecast',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 8000,
  mount TEXT NOT NULL DEFAULT '/stream',
  username TEXT NOT NULL DEFAULT 'source',
  password TEXT NOT NULL,
  bitrate_kbps INTEGER NOT NULL DEFAULT 128,
  use_tls BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_started_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.broadcast_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY broadcast_targets_owner_select ON public.broadcast_targets FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid()));
CREATE POLICY broadcast_targets_owner_insert ON public.broadcast_targets FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid()));
CREATE POLICY broadcast_targets_owner_update ON public.broadcast_targets FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid()));
CREATE POLICY broadcast_targets_owner_delete ON public.broadcast_targets FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid()));

CREATE INDEX broadcast_targets_radio_idx ON public.broadcast_targets(radio_id);

CREATE TRIGGER trg_broadcast_targets_updated_at
  BEFORE UPDATE ON public.broadcast_targets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
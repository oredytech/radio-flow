-- 1. Folders table
CREATE TABLE public.track_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  radio_id UUID NOT NULL REFERENCES public.radios(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('autodj','shows','jingles','custom')),
  is_autodj_source BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_track_folders_radio ON public.track_folders(radio_id);
CREATE UNIQUE INDEX uniq_one_autodj_source_per_radio
  ON public.track_folders(radio_id) WHERE is_autodj_source = true;

ALTER TABLE public.track_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "track_folders_public_read" ON public.track_folders FOR SELECT USING (true);
CREATE POLICY "track_folders_owner_insert" ON public.track_folders FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = track_folders.radio_id AND r.user_id = auth.uid()));
CREATE POLICY "track_folders_owner_update" ON public.track_folders FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = track_folders.radio_id AND r.user_id = auth.uid()));
CREATE POLICY "track_folders_owner_delete" ON public.track_folders FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.radios r WHERE r.id = track_folders.radio_id AND r.user_id = auth.uid()));

-- 2. Add folder_id on tracks
ALTER TABLE public.tracks ADD COLUMN folder_id UUID REFERENCES public.track_folders(id) ON DELETE SET NULL;
CREATE INDEX idx_tracks_folder ON public.tracks(folder_id);

-- 3. Backfill: create default folders for every existing radio
DO $$
DECLARE
  r RECORD;
  autodj_id UUID;
  shows_id UUID;
  jingles_id UUID;
BEGIN
  FOR r IN SELECT id FROM public.radios LOOP
    INSERT INTO public.track_folders(radio_id, name, kind, is_autodj_source, position)
      VALUES (r.id, 'Auto DJ', 'autodj', true, 0) RETURNING id INTO autodj_id;
    INSERT INTO public.track_folders(radio_id, name, kind, is_autodj_source, position)
      VALUES (r.id, 'Émissions', 'shows', false, 1) RETURNING id INTO shows_id;
    INSERT INTO public.track_folders(radio_id, name, kind, is_autodj_source, position)
      VALUES (r.id, 'Jingles', 'jingles', false, 2) RETURNING id INTO jingles_id;

    UPDATE public.tracks SET folder_id = autodj_id WHERE radio_id = r.id AND kind <> 'jingle';
    UPDATE public.tracks SET folder_id = jingles_id WHERE radio_id = r.id AND kind = 'jingle';
  END LOOP;
END $$;

-- 4. Trigger: auto-create default folders when a new radio is created
CREATE OR REPLACE FUNCTION public.create_default_folders()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.track_folders(radio_id, name, kind, is_autodj_source, position)
    VALUES (NEW.id, 'Auto DJ', 'autodj', true, 0);
  INSERT INTO public.track_folders(radio_id, name, kind, is_autodj_source, position)
    VALUES (NEW.id, 'Émissions', 'shows', false, 1);
  INSERT INTO public.track_folders(radio_id, name, kind, is_autodj_source, position)
    VALUES (NEW.id, 'Jingles', 'jingles', false, 2);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_create_default_folders
  AFTER INSERT ON public.radios
  FOR EACH ROW EXECUTE FUNCTION public.create_default_folders();
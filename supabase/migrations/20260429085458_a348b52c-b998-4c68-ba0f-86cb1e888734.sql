-- 1. Étendre l'enum program_type
ALTER TYPE public.program_type ADD VALUE IF NOT EXISTS 'jingle';

-- 2. Table tracks (bibliothèque audio par radio)
CREATE TABLE public.tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  radio_id UUID NOT NULL REFERENCES public.radios(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  audio_url TEXT NOT NULL,
  duration_seconds NUMERIC,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'music' CHECK (kind IN ('music','jingle')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tracks_radio_position ON public.tracks(radio_id, position);

ALTER TABLE public.tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tracks_public_read" ON public.tracks
  FOR SELECT USING (true);

CREATE POLICY "tracks_owner_insert" ON public.tracks
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.radios r WHERE r.id = tracks.radio_id AND r.user_id = auth.uid()
  ));

CREATE POLICY "tracks_owner_update" ON public.tracks
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.radios r WHERE r.id = tracks.radio_id AND r.user_id = auth.uid()
  ));

CREATE POLICY "tracks_owner_delete" ON public.tracks
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.radios r WHERE r.id = tracks.radio_id AND r.user_id = auth.uid()
  ));

-- 3. Bucket de stockage audio
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'radio-audio',
  'radio-audio',
  true,
  52428800, -- 50 MB
  ARRAY['audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/webm','audio/mp4','audio/aac','audio/x-m4a','audio/flac']
);

-- Policies storage : structure {user_id}/{radio_id}/{filename}
CREATE POLICY "audio_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'radio-audio');

CREATE POLICY "audio_owner_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'radio-audio'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "audio_owner_update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'radio-audio'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "audio_owner_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'radio-audio'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- 4. Mise à jour de validate_program (jingle = ponctuel, pas d'overlap check, audio_url requis)
CREATE OR REPLACE FUNCTION public.validate_program()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.day_of_week < 0 OR NEW.day_of_week > 6 THEN
    RAISE EXCEPTION 'day_of_week must be 0-6';
  END IF;
  IF NEW.end_time <= NEW.start_time THEN
    RAISE EXCEPTION 'end_time must be after start_time';
  END IF;
  IF NEW.type IN ('playlist','jingle') AND (NEW.audio_url IS NULL OR NEW.audio_url = '') THEN
    RAISE EXCEPTION 'audio_url required for % programs', NEW.type;
  END IF;
  IF NEW.type = 'live' AND (NEW.stream_url IS NULL OR NEW.stream_url = '') THEN
    RAISE EXCEPTION 'stream_url required for live programs';
  END IF;
  -- Overlap check uniquement pour playlist et live (jingle = ponctuel court)
  IF NEW.type IN ('playlist','live') AND EXISTS (
    SELECT 1 FROM public.programs p
    WHERE p.radio_id = NEW.radio_id
      AND p.day_of_week = NEW.day_of_week
      AND p.type = NEW.type
      AND p.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND p.start_time < NEW.end_time
      AND p.end_time > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'Program overlaps an existing % program on this day', NEW.type;
  END IF;
  RETURN NEW;
END;
$function$;

-- Recréer le trigger (au cas où il manquait)
DROP TRIGGER IF EXISTS trg_validate_program ON public.programs;
CREATE TRIGGER trg_validate_program
  BEFORE INSERT OR UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.validate_program();
CREATE TABLE IF NOT EXISTS public.program_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES public.tracks(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (program_id, track_id, position)
);

CREATE INDEX IF NOT EXISTS idx_program_tracks_program_position
  ON public.program_tracks(program_id, position, created_at);

CREATE INDEX IF NOT EXISTS idx_program_tracks_track
  ON public.program_tracks(track_id);

ALTER TABLE public.program_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "program_tracks_public_read"
ON public.program_tracks
FOR SELECT
USING (true);

CREATE POLICY "program_tracks_owner_insert"
ON public.program_tracks
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.programs p
    JOIN public.radios r ON r.id = p.radio_id
    WHERE p.id = program_tracks.program_id
      AND r.user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1
    FROM public.tracks t
    JOIN public.programs p ON p.id = program_tracks.program_id
    WHERE t.id = program_tracks.track_id
      AND t.radio_id = p.radio_id
  )
);

CREATE POLICY "program_tracks_owner_update"
ON public.program_tracks
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM public.programs p
    JOIN public.radios r ON r.id = p.radio_id
    WHERE p.id = program_tracks.program_id
      AND r.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.programs p
    JOIN public.radios r ON r.id = p.radio_id
    WHERE p.id = program_tracks.program_id
      AND r.user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1
    FROM public.tracks t
    JOIN public.programs p ON p.id = program_tracks.program_id
    WHERE t.id = program_tracks.track_id
      AND t.radio_id = p.radio_id
  )
);

CREATE POLICY "program_tracks_owner_delete"
ON public.program_tracks
FOR DELETE
USING (
  EXISTS (
    SELECT 1
    FROM public.programs p
    JOIN public.radios r ON r.id = p.radio_id
    WHERE p.id = program_tracks.program_id
      AND r.user_id = auth.uid()
  )
);

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
  IF NEW.type = 'live' AND (NEW.stream_url IS NULL OR NEW.stream_url = '') THEN
    RAISE EXCEPTION 'stream_url required for live programs';
  END IF;
  IF NEW.type IN ('playlist','jingle') AND NEW.stream_url IS NOT NULL AND NEW.stream_url <> '' THEN
    RAISE EXCEPTION 'stream_url is only allowed for live programs';
  END IF;
  -- Les programmes audio peuvent être basés sur audio_url (ancien mode)
  -- ou sur public.program_tracks (nouveau mode multi-pistes, créé après le programme).
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
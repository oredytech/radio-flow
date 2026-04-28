CREATE OR REPLACE FUNCTION public.validate_program()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.day_of_week < 0 OR NEW.day_of_week > 6 THEN
    RAISE EXCEPTION 'day_of_week must be 0-6';
  END IF;
  IF NEW.end_time <= NEW.start_time THEN
    RAISE EXCEPTION 'end_time must be after start_time';
  END IF;
  IF NEW.type = 'playlist' AND (NEW.audio_url IS NULL OR NEW.audio_url = '') THEN
    RAISE EXCEPTION 'audio_url required for playlist programs';
  END IF;
  IF NEW.type = 'live' AND (NEW.stream_url IS NULL OR NEW.stream_url = '') THEN
    RAISE EXCEPTION 'stream_url required for live programs';
  END IF;
  IF EXISTS (
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
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_program() FROM PUBLIC, anon, authenticated;
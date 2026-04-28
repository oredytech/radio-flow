-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto profile creation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Radios
CREATE TABLE public.radios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.radios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "radios_public_read" ON public.radios FOR SELECT USING (true);
CREATE POLICY "radios_owner_insert" ON public.radios FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "radios_owner_update" ON public.radios FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "radios_owner_delete" ON public.radios FOR DELETE USING (auth.uid() = user_id);

-- Program type enum
CREATE TYPE public.program_type AS ENUM ('playlist', 'live');

-- Programs
CREATE TABLE public.programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  radio_id UUID NOT NULL REFERENCES public.radios(id) ON DELETE CASCADE,
  type public.program_type NOT NULL,
  title TEXT,
  day_of_week SMALLINT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  audio_url TEXT,
  stream_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "programs_public_read" ON public.programs FOR SELECT USING (true);
CREATE POLICY "programs_owner_insert" ON public.programs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid())
);
CREATE POLICY "programs_owner_update" ON public.programs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid())
);
CREATE POLICY "programs_owner_delete" ON public.programs FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.radios r WHERE r.id = radio_id AND r.user_id = auth.uid())
);

-- Validation trigger: day_of_week 0-6, end > start, no overlap with same type-priority
CREATE OR REPLACE FUNCTION public.validate_program()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
  -- Overlap check (same radio, same day, same type)
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
CREATE TRIGGER programs_validate BEFORE INSERT OR UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.validate_program();

CREATE INDEX idx_programs_radio_day ON public.programs(radio_id, day_of_week);
CREATE INDEX idx_radios_slug ON public.radios(slug);
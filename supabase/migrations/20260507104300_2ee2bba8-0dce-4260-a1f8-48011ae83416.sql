-- Add jingle scheduling preferences per radio
ALTER TABLE public.radios
  ADD COLUMN IF NOT EXISTS jingle_mode text NOT NULL DEFAULT 'after_track',
  ADD COLUMN IF NOT EXISTS jingle_order text NOT NULL DEFAULT 'sequential',
  ADD COLUMN IF NOT EXISTS jingle_every integer NOT NULL DEFAULT 1;

-- Validate values
ALTER TABLE public.radios
  DROP CONSTRAINT IF EXISTS radios_jingle_mode_chk;
ALTER TABLE public.radios
  ADD CONSTRAINT radios_jingle_mode_chk
  CHECK (jingle_mode IN ('off','after_track','after_program','overlap'));

ALTER TABLE public.radios
  DROP CONSTRAINT IF EXISTS radios_jingle_order_chk;
ALTER TABLE public.radios
  ADD CONSTRAINT radios_jingle_order_chk
  CHECK (jingle_order IN ('sequential','random'));

ALTER TABLE public.radios
  DROP CONSTRAINT IF EXISTS radios_jingle_every_chk;
ALTER TABLE public.radios
  ADD CONSTRAINT radios_jingle_every_chk
  CHECK (jingle_every BETWEEN 1 AND 20);
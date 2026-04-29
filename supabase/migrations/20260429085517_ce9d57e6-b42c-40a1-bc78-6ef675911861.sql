-- Remplace la SELECT policy trop large par une politique qui :
-- - autorise l'accès direct aux URLs publiques (toujours via CDN public)
-- - bloque le listing anonyme (l'API list nécessite désormais d'être propriétaire du dossier)
DROP POLICY IF EXISTS "audio_public_read" ON storage.objects;

-- Lecture publique uniquement quand on cible un fichier précis (pas via list)
-- En pratique, Supabase Storage public bucket sert déjà les fichiers via le CDN public
-- sans passer par cette policy. On restreint donc le SELECT SQL à l'owner.
CREATE POLICY "audio_owner_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'radio-audio'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
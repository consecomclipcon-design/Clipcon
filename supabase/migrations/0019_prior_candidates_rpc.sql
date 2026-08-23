-- RPC: retorna todos os candidatos já usados para um dado source_video
-- através de qualquer projeto da mesma workspace.
-- Usado pela camada L3 do sistema de anti-duplicação.

CREATE OR REPLACE FUNCTION prior_candidates_for_source(p_source_video_id uuid)
RETURNS TABLE(start_seconds double precision, end_seconds double precision)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT cc.start_seconds, cc.end_seconds
  FROM clip_candidates cc
  INNER JOIN clips c ON c.candidate_id = cc.id
  INNER JOIN publications pub ON pub.clip_id = c.id AND pub.status IN ('published', 'scheduled', 'uploading')
  WHERE cc.source_video_id = p_source_video_id
     OR (cc.source_video_id IS NULL AND EXISTS (
       SELECT 1 FROM source_videos sv
       WHERE sv.id = p_source_video_id
         AND sv.project_id = cc.project_id
     ))
  ORDER BY cc.start_seconds;
$$;

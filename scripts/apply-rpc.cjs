const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const SQL = `
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
`;

(async () => {
  // Supabase admin API doesn't have exec_sql RPC by default.
  // We need to use the SQL API or run via supabase CLI.
  // For now, let's test if the function already exists after the migration was supposed to run.
  const { data, error } = await db.rpc('prior_candidates_for_source', {
    p_source_video_id: 'ece1e061-cc0e-48c1-97de-fb358d52e5e7',
  });
  if (error) {
    console.log('RPC not available:', error.message);
    console.log('Need to apply migration manually via Supabase dashboard.');
    console.log('SQL to run:');
    console.log(SQL);
    return;
  }
  console.log('RPC works! Result:', JSON.stringify(data));
})();

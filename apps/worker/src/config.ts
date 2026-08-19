export const config = {
  SUPABASE_URL: process.env.SUPABASE_URL ?? null,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY ?? null,
  APP_SECRET: process.env.APP_SECRET ?? null,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? null,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? null,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? null,
  GOOGLE_DRIVE_ROOT_FOLDER_ID: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? null,
  GROQ_API_KEY: process.env.GROQ_API_KEY ?? null,
  GROQ_TRANSCRIPTION_MODEL: process.env.GROQ_TRANSCRIPTION_MODEL ?? null,
  GROQ_ANALYSIS_MODEL: process.env.GROQ_ANALYSIS_MODEL ?? null,
  ytdlpCookiesB64: process.env.YTDLP_COOKIES ?? null,
  pollMs: Math.max(500, Number(process.env.WORKER_POLL_MS ?? 2000)),
  maxAttempts: Math.min(5, Math.max(1, Number(process.env.WORKER_MAX_ATTEMPTS ?? 5))),
};

export function assertSupabaseConfig() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required by the worker');
}
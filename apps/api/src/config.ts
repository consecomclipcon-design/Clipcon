import { z } from 'zod';

const schema = z.object({ SUPABASE_URL: z.string().url(), SUPABASE_SECRET_KEY: z.string().min(1), APP_SECRET: z.string().min(32), API_PORT: z.coerce.number().default(4000), PORT: z.coerce.number().optional(), WEB_ORIGIN: z.string().url().default('http://localhost:5173'), GOOGLE_CLIENT_ID: z.string().min(1).optional(), GOOGLE_CLIENT_SECRET: z.string().min(1).optional(), GOOGLE_REDIRECT_URI: z.string().url().optional(), GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().min(1).optional(), BOOTSTRAP_MASTER_EMAIL: z.string().email().optional(), BOOTSTRAP_MASTER_PASSWORD: z.string().min(12).optional() });
export const config = schema.parse(process.env);
export const listenPort = config.PORT ?? config.API_PORT;

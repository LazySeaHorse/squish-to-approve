import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const schema = z.object({
  ALLOWED_JIDS: z.string().min(1).transform(s => s.split(',').map(j => j.trim())),
  BAILEYS_DB_PATH: z.string().default('./data/baileys.db'),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),

  TEMPLATE_ID_IG: z.string().min(1),
  TEMPLATE_ID_IG_FB: z.string().min(1),

  OUTPUT_FOLDER_ID: z.string().min(1),
  TEMP_IMAGE_FOLDER_ID: z.string().min(1),

  TRIGGER_URL: z.string().min(1),
  OUTPUT_DOC_PERMISSION: z.enum(['reader', 'writer']).default('reader'),
  PAIRING_TIMEOUT_MS: z.coerce.number().default(120000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid configuration:\n', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

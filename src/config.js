import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  AUTH_MODE: z.enum(['supabase', 'test-key']).default('supabase'),
  TEST_API_KEY: z.string().default(''),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_ANON_KEY: z.string().default(''),
  STORAGE: z.enum(['postgres', 'memory']).default('postgres'),
  DATABASE_URL: z.string().default(''),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  MODEL_TRANSPORT: z.enum(['direct', 'worker']).default('direct'),
  MODEL_WORKER_TOKEN: z.string().default(''),
  GEMMA_CHAT_URL: z.string().url().default('http://127.0.0.1:8088/v1/chat/completions'),
  BODHAN_WS_URL: z.string().url().default('ws://127.0.0.1:8086/v1/audio/transcriptions/realtime'),
  PARLER_SPEECH_URL: z.string().url().default('http://127.0.0.1:8084/v1/audio/speech'),
  GEMMA_API_KEY: z.string().default(''), BODHAN_API_KEY: z.string().default(''), PARLER_API_KEY: z.string().default(''),
  GEMMA_MODEL: z.string().default('voice-lab-gemma4'),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(90000),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(2048).default(1024),
  VOICE_SESSION_SECONDS: z.coerce.number().int().min(10).max(600).default(600),
  ALLOWED_ORIGINS: z.string().default(''),
  BACKEND_URL: z.string().default(''),
});
export function loadConfig(env = process.env, { worker = false } = {}) {
  const c = envSchema.parse(env);
  if (worker) {
    if (!c.BACKEND_URL || c.MODEL_WORKER_TOKEN.length < 32) throw new Error('Worker requires BACKEND_URL and a MODEL_WORKER_TOKEN of at least 32 characters.');
    const u = new URL(c.BACKEND_URL);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('Remote worker backend must use HTTPS.');
  } else {
    if (c.AUTH_MODE === 'test-key' && c.TEST_API_KEY.length < 32) throw new Error('TEST_API_KEY must contain at least 32 characters.');
    if (c.AUTH_MODE === 'supabase' && (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY)) throw new Error('Configure SUPABASE_URL and SUPABASE_ANON_KEY.');
    if (c.STORAGE === 'postgres' && !c.DATABASE_URL) throw new Error('DATABASE_URL is required for persistent history.');
    if (c.NODE_ENV === 'production' && c.STORAGE !== 'postgres') throw new Error('Production requires Postgres; memory history is development-only.');
    if (c.MODEL_TRANSPORT === 'worker' && c.MODEL_WORKER_TOKEN.length < 32) throw new Error('MODEL_WORKER_TOKEN must contain at least 32 characters.');
    if (c.TEST_API_KEY && c.TEST_API_KEY === c.MODEL_WORKER_TOKEN) throw new Error('Use different test and worker keys.');
  }
  for (const key of ['GEMMA_CHAT_URL', 'BODHAN_WS_URL', 'PARLER_SPEECH_URL']) {
    const u = new URL(c[key]);
    const allowed = key === 'BODHAN_WS_URL' ? ['ws:', 'wss:'] : ['http:', 'https:'];
    if (!allowed.includes(u.protocol) || u.username || u.password) throw new Error(`Invalid ${key}`);
    if (c.NODE_ENV === 'production' && c.MODEL_TRANSPORT === 'direct' && !['https:', 'wss:'].includes(u.protocol)) throw new Error('Production direct model endpoints require TLS.');
  }
  c.origins = c.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  return c;
}

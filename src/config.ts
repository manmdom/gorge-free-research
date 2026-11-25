import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();

function loadDotEnv(): void {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const int = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  root,
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  skillsDir: path.join(root, '.opencode', 'skills'),
  downloadSecret: process.env.DOWNLOAD_SECRET ?? crypto.randomBytes(32).toString('hex'),
  downloadTtlSeconds: int(process.env.DOWNLOAD_TTL_SECONDS, 3600),
  inlineWorker: process.env.INLINE_WORKER !== '0',
  llm: {
    url: process.env.LLM_API_URL ?? '',
    key: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  },
  research: {
    url: process.env.RESEARCH_API_URL ?? '',
    key: process.env.RESEARCH_API_KEY ?? '',
  },
  stockProvider: process.env.STOCK_PROVIDER ?? 'none',
  ttsProvider: process.env.TTS_PROVIDER ?? 'edge',
  voices: {
    female: process.env.ARABIC_VOICE_FEMALE ?? 'ar-SA-ZariyahNeural',
    male: process.env.ARABIC_VOICE_MALE ?? 'ar-SA-HamedNeural',
  },
  render: {
    size: process.env.RENDER_SIZE ?? '1080x1920',
    fps: int(process.env.RENDER_FPS, 30),
    bgm: process.env.BGM ?? 'auto',
  },
  retentionHours: int(process.env.ARTIFACT_RETENTION_HOURS, 168),
};

export function providerStatus(): Record<string, { enabled: boolean; mode: string }> {
  return {
    research: {
      enabled: true,
      mode: config.research.url ? 'api' : 'wikipedia-ar-ddg',
    },
    llm: { enabled: Boolean(config.llm.url && config.llm.key), mode: config.llm.url ? 'openai-compatible' : 'local-template' },
    image: { enabled: true, mode: 'programmatic-pillow' },
    video: { enabled: false, mode: 'not-configured' },
    stock: {
      enabled: config.stockProvider === 'wikimedia',
      mode: config.stockProvider === 'wikimedia' ? 'wikimedia-commons-cc' : 'programmatic-only',
    },
    tts: { enabled: config.ttsProvider === 'edge', mode: config.ttsProvider === 'edge' ? 'edge-tts' : 'none-mock' },
    music: { enabled: config.render.bgm !== 'none', mode: config.render.bgm === 'auto' ? 'programmatic' : 'file' },
    storage: { enabled: true, mode: 'local-filesystem' },
    rendering: { enabled: true, mode: 'ffmpeg-libass' },
  };
}

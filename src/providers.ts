import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import type { SourceRef } from './types.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StockImage {
  title: string;
  url: string;
  descriptionUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
  attribution: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
          settled = true;
        }, options.timeoutMs)
      : null;
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return (await response.json()) as T;
}

const AR_STOPWORDS = new Set([
  'عن', 'في', 'من', 'على', 'إلى', 'الى', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'كان', 'كانت',
  'How', 'what', 'why', 'for', 'and', 'the', 'with', 'about', 'best', 'good', 'benefits', 'فوائد',
]);

function normalizeArabic(value: string): string {
  return value
    .replace(/[\u064B-\u065F\u0670]/g, '') // diacritics
    .replace(/\u0640/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

function topicTokens(topic: string): string[] {
  return normalizeArabic(topic)
    .split(/[^\u0600-\u06ff\w]+/u)
    .filter((token) => token.length >= 4 && !AR_STOPWORDS.has(token));
}

function relevance(topic: string, text: string): number {
  const haystack = normalizeArabic(text);
  return topicTokens(topic).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function cleanSnippet(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function wikipediaSources(topic: string): Promise<SourceRef[]> {
  const url = new URL('https://ar.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', topic);
  url.searchParams.set('srprop', 'snippet');
  url.searchParams.set('srlimit', '6');
  url.searchParams.set('format', 'json');
  const data = await fetchJson<{
    query?: { search?: Array<{ title: string; pageid: number; snippet: string }> };
  }>(url.toString(), { headers: { 'user-agent': 'GorgeReels/1.0 (research provider)' } }, 12_000);
  return (data.query?.search ?? [])
    .map((item) => {
      const title = cleanSnippet(item.title);
      const snippet = cleanSnippet(item.snippet);
      return {
        title,
        publisher: 'Wikipedia (العربية)',
        url: `https://ar.wikipedia.org/?curid=${item.pageid}`,
        supports: snippet
          ? `خلفية: ${snippet.slice(0, 220)}. لا تُستخدم كدليل على أرقام أو ادعاءات غير مؤكدة.`
          : 'خلفية عامة للموضوع؛ لا تُستخدم كدليل على أرقام أو ادعاءات محددة.',
        _score: relevance(`${topic} ${title}`, `${title} ${snippet}`),
      };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 3)
    .map(({ _score, ...source }) => source);
}

async function duckDuckGoSources(topic: string): Promise<SourceRef[]> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', topic);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  const data = await fetchJson<{
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  }>(url.toString(), { headers: { 'user-agent': 'GorgeReels/1.0 (research provider)' } }, 12_000);
  const candidates: SourceRef[] = [];
  if (data.AbstractURL && data.AbstractText) {
    candidates.push({
      title: data.Heading || topic,
      publisher: 'DuckDuckGo Instant Answer',
      url: data.AbstractURL,
      supports: `${cleanSnippet(data.AbstractText).slice(0, 240)}. يُفضّل التحقق من المصدر الأصلي.`,
    });
  }
  for (const item of (data.RelatedTopics ?? []).slice(0, 6)) {
    if (!item.FirstURL || !item.Text) continue;
    candidates.push({
      title: cleanSnippet(item.Text).split(' - ')[0].slice(0, 120),
      publisher: 'DuckDuckGo Related Topics',
      url: item.FirstURL,
      supports: `${cleanSnippet(item.Text).slice(0, 220)}. يُفضّل التحقق من المصدر الأصلي.`,
    });
  }
  return candidates.filter((s) => relevance(topic, `${s.title} ${s.supports}`) > 0).slice(0, 2);
}

/** Free, keyless research: configured API -> Wikipedia -> DuckDuckGo fallback. */
export async function researchTopic(topic: string): Promise<{ sources: SourceRef[]; note: string }> {
  if (config.research.url) {
    try {
      const data = await fetchJson<{ sources?: SourceRef[] }>(config.research.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.research.key ? { authorization: `Bearer ${config.research.key}` } : {}),
        },
        body: JSON.stringify({ topic, language: 'ar' }),
      });
      const sources = (data.sources ?? []).filter(
        (s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url),
      );
      return {
        sources,
        note: sources.length ? 'مصادر من مزوّد البحث المُهيّأ.' : 'لم يُرجع مزوّد البحث مصادر صالحة.',
      };
    } catch (error) {
      return { sources: [], note: `تعذّر الوصول إلى مزوّد البحث: ${(error as Error).message}` };
    }
  }

  const notes: string[] = [];
  let sources: SourceRef[] = [];
  try {
    sources = await wikipediaSources(topic);
    if (!sources.length) notes.push('لم تُعد ويكيبيدي نتائج مرتبطة بالموضوع.');
  } catch (error) {
    notes.push(`تعذّر استخدام ويكيبيدي: ${(error as Error).message}`);
  }
  if (sources.length < 2) {
    try {
      const extras = await duckDuckGoSources(topic);
      const seen = new Set(sources.map((s) => s.url));
      sources.push(...extras.filter((s) => !seen.has(s.url)));
    } catch (error) {
      notes.push(`تعذّر استخدام البحث الاحتياطي: ${(error as Error).message}`);
    }
  }
  const note = sources.length
    ? `مصادر مجانية بلا مفتاح: ${sources.map((s) => s.publisher.split(' ')[0]).filter((v, i, a) => a.indexOf(v) === i).join(' + ')}. النص المحلي يتجنّب الأرقام غير المؤكدة.${notes.length ? ' ' + notes.join(' ') : ''}`
    : `البحث متعذّر حالياً. ${notes.join(' ')} النص سيتجنّب الادعاءات المحددة.`;
  return { sources: sources.slice(0, 4), note };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function metadataValue(metadata: Record<string, { value?: string }> | undefined, key: string): string {
  return stripHtml(metadata?.[key]?.value ?? '');
}

/** Free, keyless stock search through Wikimedia Commons (CC / public-domain only). */
export async function findStockImages(topic: string, count: number): Promise<StockImage[]> {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', `filetype:bitmap ${topic}`);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', String(Math.max(1, Math.min(count, 10))));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|extmetadata');
  url.searchParams.set('iiurlwidth', '1280');
  url.searchParams.set('format', 'json');
  const data = await fetchJson<{
    query?: {
      pages?: Record<string, {
        title: string;
        imageinfo?: Array<{
          thumburl?: string;
          url: string;
          descriptionurl: string;
          extmetadata?: Record<string, { value?: string }>;
        }>;
      }>;
    };
  }>(url.toString(), { headers: { 'user-agent': 'GorgeReels/1.0 (stock provider)' } }, 15_000);

  const images: StockImage[] = [];
  for (const page of Object.values(data.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const metadata = info.extmetadata;
    const license = metadataValue(metadata, 'LicenseShortName');
    const isFree = /^(cc|public domain|pd\b)/i.test(license);
    if (!isFree) continue;
    const imageUrl = info.thumburl ?? info.url;
    if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(imageUrl)) continue;
    const creator = metadataValue(metadata, 'Artist') || 'Wikimedia Commons';
    const licenseUrl = stripHtml(metadata?.[`LicenseUrl`]?.value ?? 'https://commons.wikimedia.org/wiki/Commons:Licensing');
    images.push({
      title: page.title.replace(/^File:/i, ''),
      url: imageUrl,
      descriptionUrl: info.descriptionurl,
      creator: creator.slice(0, 160),
      license: license.slice(0, 80),
      licenseUrl: /^https:\/\//.test(licenseUrl) ? licenseUrl : 'https://commons.wikimedia.org/wiki/Commons:Licensing',
      attribution: `الصورة: ${page.title.replace(/^File:/i, '').slice(0, 90)} — ${creator.slice(0, 90)} — ${license.slice(0, 40)}`,
    });
    if (images.length >= count) break;
  }
  return images;
}

/** Download verified Commons thumbnails into a job directory. */
export async function downloadStockImages(images: StockImage[], outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const saved: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const response = await fetch(image.url, {
      headers: { 'user-agent': 'GorgeReels/1.0 (stock provider)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} عند تنزيل صورة ستوك`);
    const type = response.headers.get('content-type') ?? '';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error(`صيغة صورة ستوك غير مدعومة: ${type}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024) throw new Error('صورة ستوك أكبر من الحد المسموح');
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const file = path.join(outDir, `stock_${String(i).padStart(2, '0')}.${ext}`);
    fs.writeFileSync(file, bytes);
    saved.push(file);
  }
  return saved;
}

export async function generateText(system: string, user: string): Promise<{ text: string; mode: 'llm' | 'local-template' }> {
  if (!config.llm.url || !config.llm.key) throw new Error('LLM provider is not configured');
  const data = await fetchJson<{
    choices?: Array<{ message?: { content?: string } }>;
  }>(config.llm.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.llm.key}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    }),
  }, 90_000);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned an empty response');
  return { text: content, mode: 'llm' };
}

export function safeJsonText(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

import type { IncomingMessage } from 'node:http';
import type { Platform, PlatformGatewayEvent } from '@agentdeck/contracts';
import type { AppStore } from '../../../lib/app-store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { AliasVault, maskText } from '../../dlp/mask.ts';
import { maskRulesFor } from '../../dlp/default-rules.ts';
import { dataMaskOn } from '../data-mask.ts';
import type { PlatformDriver } from '../drivers/driver.ts';
import { driverOf } from '../drivers/index.ts';
import { callUpstream, UpstreamError } from './upstream.ts';
import { serverText } from '../../../lib/server-texts.ts';

/**
 * Ручка картинок контура (`driver.images = { api }`) — ЧЕРЕЗ шлюз.
 *
 * До 17.09.2026 панель ходила на неё напрямую ключом контура: ни следа запроса,
 * ни учёта расхода, ни перевода отказов 402/451, ни защиты данных — а ключ тот же
 * корпоративный, и промпт картинки несёт те же данные, что и чат. Решение
 * владельца: у шлюза четвёртый маршрут, и картинка идёт тем же конвейером.
 *
 * Чем этот маршрут отличается от чата — и почему он отдельным модулем:
 *   - ПОВТОРА НЕТ. Чат повторяет 429/5xx до первого байта клиенту; картинка —
 *     платная работа, которая могла состояться, и повтор нарисовал бы и списал
 *     её дважды;
 *   - ЗАГОЛОВКОВ ждём дольше. Ручка не потоковая: заголовки приходят вместе с
 *     готовой картинкой, а рисование — минуты, и общий потолок в 60 с оборвал бы
 *     уже оплаченную работу;
 *   - ответ уходит клиенту БАЙТ В БАЙТ: переводить нечего, а в след попадает
 *     только размер картинки, ни байта её самой;
 *   - защита данных смотрит на ПРОМПТ: у этой ручки нет `messages`, и разбор тела
 *     по диалекту чата пропустил бы промпт немаскированным.
 *
 * Помощники конвейера (след, отказ, учёт) приезжают параметром, а не импортом:
 * конвейер импортирует этот модуль, и обратный импорт замкнул бы круг.
 */

/** Потолок ожидания ЗАГОЛОВКОВ: столько же ждёт картинку сама панель. */
export const IMAGES_HEADERS_TIMEOUT_MS = 180_000;

/** Потолок ответа: base64 длиннее байтов на треть, картинка панели — до 8 МБ. */
const MAX_IMAGES_ANSWER_BYTES = 16 * 1024 * 1024;

export interface ImagesRefusal {
  platformId: string;
  path: string;
  dialect: 'openai-compat';
  status: number;
  code: string;
  message: string;
}

export interface ImagesContext {
  platform: Platform;
  token: string;
  path: string;
  store: AppStore;
  appDataDir: string;
  fetchImpl?: PlatformFetch;
}

/** Помощники конвейера, уже привязанные к запросу. */
export interface ImagesIo {
  readBody: (request: IncomingMessage) => Promise<Buffer | undefined>;
  refuse: (refusal: ImagesRefusal) => void;
  refuseStatus: (
    upstream: Response,
    context: {
      platform: Platform;
      driver: PlatformDriver;
      path: string;
      dialect: 'openai-compat';
      model: string;
      lost: string[];
    },
  ) => Promise<void>;
  record: (event: Partial<PlatformGatewayEvent>) => void;
  countUsage: (
    model: string,
    tokens: { promptTokens: number; completionTokens: number; totalTokens: number },
    /** Картинка дошла, а счёта за неё ручка не прислала (MD-09). */
    unreported?: boolean,
  ) => void;
  respond: (status: number, text: string) => void;
  signal: AbortSignal;
}

export async function imagesRequest(
  request: IncomingMessage,
  context: ImagesContext,
  io: ImagesIo,
): Promise<void> {
  const { platform, token, path } = context;
  const base = { platformId: platform.id, path, dialect: 'openai-compat' as const };
  const driver = driverOf(platform);
  const images = driver.images;

  if (typeof images !== 'object') {
    request.resume();
    return io.refuse({
      ...base,
      status: 404,
      code: 'not_found_error',
      message: serverText('gateway-images-not-declared', { title: platform.title }),
    });
  }

  const raw = await io.readBody(request);
  if (raw === undefined) {
    request.destroy();
    return io.refuse({
      ...base,
      status: 413,
      code: 'request_too_large',
      message: serverText('gateway-body-too-large'),
    });
  }
  const body = parseObject(raw.toString('utf8'));
  if (!body) {
    return io.refuse({
      ...base,
      status: 400,
      code: 'invalid_request_error',
      message: serverText('gateway-body-not-json'),
    });
  }

  const masked = maskPrompt(body, context, driver);
  if ('refusal' in masked) {
    // 400, а не 403: отказ по содержимому — не ошибка доступа, и CLI не должен
    // читать его как «ключ не принят» (решение 1 CONTOUR-DECISIONS).
    return io.refuse({
      ...base,
      status: 400,
      code: 'invalid_request_error',
      message: masked.refusal,
    });
  }

  const model = typeof body.model === 'string' ? body.model : '';
  let upstream: Response;
  try {
    upstream = await callUpstream({
      platform,
      token,
      path: images.api,
      body: JSON.stringify(masked.body),
      signal: io.signal,
      fetchImpl: context.fetchImpl,
      accept: 'application/json',
      // Платная картинка повтором рисуется и списывается дважды.
      retry: false,
      headersTimeoutMs: IMAGES_HEADERS_TIMEOUT_MS,
    });
  } catch (error) {
    return io.refuse({
      ...base,
      status: 502,
      code: 'api_error',
      message: error instanceof UpstreamError ? error.message : String(error),
    });
  }

  if (upstream.status >= 400) {
    return io.refuseStatus(upstream, {
      platform,
      driver,
      path,
      dialect: base.dialect,
      model,
      lost: [],
    });
  }

  const text = await readCapped(upstream);
  if (text === undefined) {
    return io.refuse({
      ...base,
      status: 502,
      code: 'api_error',
      message: serverText('gateway-images-too-large'),
    });
  }

  io.respond(200, text);

  const payload = parseObject(text);
  const tokens = usageOf(payload);
  // Ответ уже ушёл человеку (`io.respond` выше), значит расход был. Ноль здесь
  // значит «ручка не отчиталась», и учёт узнаёт об этом тем же признаком, что
  // и трасса ниже, — иначе полоса бюджета молчала бы о своей неполноте.
  io.countUsage(model, tokens, tokens.totalTokens === 0);
  const imageBytes = imageBytesOf(payload);
  io.record({
    ...base,
    status: 200,
    totalTokens: tokens.totalTokens,
    // Расхода ручка не прислала — так и сказано, а не молчаливым нулём (MD-09).
    ...(tokens.totalTokens === 0 ? { usageUnreported: true as const } : {}),
    ...(imageBytes > 0 ? { imageBytes } : {}),
  });
}

/**
 * Промпт через защиту данных — тем же решением, что и чат (`dataMaskOn`), и тем
 * же fail-closed: сломанный файл правил при включённой защите — отказ.
 */
function maskPrompt(
  body: Record<string, unknown>,
  context: ImagesContext,
  driver: PlatformDriver,
): { body: Record<string, unknown> } | { refusal: string } {
  const { platform } = context;
  if (!dataMaskOn(platform, driver, context.store.getSettings().dlp.enabled)) return { body };
  if (typeof body.prompt !== 'string') return { body };

  const set = maskRulesFor(context.appDataDir);
  if (set.source === 'broken') {
    return { refusal: serverText('gateway-mask-rules-broken', { error: set.error }) };
  }
  // Словарь меток — на запрос: картинка метку обратно не несёт, разворачивать
  // нечего, но вид метки обязан обходить метки самой платформы.
  const vault = new AliasVault({ avoid: driver.placeholderPattern });
  const result = maskText(body.prompt, set.rules, vault);
  if (result.blockedBy) {
    return {
      refusal: serverText('gateway-mask-blocked', { rule: result.blockedBy.ruleName }),
    };
  }
  return { body: { ...body, prompt: result.text } };
}

/** Расход, если ручка его прислала: у OpenAI — `input/output_tokens`. */
function usageOf(payload: Record<string, unknown> | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const usage = payload && isRecord(payload.usage) ? payload.usage : {};
  const promptTokens = numberOf(usage.input_tokens) || numberOf(usage.prompt_tokens);
  const completionTokens = numberOf(usage.output_tokens) || numberOf(usage.completion_tokens);
  const totalTokens = numberOf(usage.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** Размер картинок по base64 строк `data` — только число, в след не едет ни байта. */
function imageBytesOf(payload: Record<string, unknown> | undefined): number {
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  let bytes = 0;
  for (const row of rows) {
    if (isRecord(row) && typeof row.b64_json === 'string') {
      bytes += Math.floor((row.b64_json.replace(/=+$/, '').length * 3) / 4);
    }
  }
  return bytes;
}

async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_IMAGES_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

import type { EndpointProfile, Platform } from '@agentdeck/contracts';
import type { CoreContourLinkReply } from '@agentdeck/contracts/core/hops';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import type { PlatformFetch } from '../platform/ca-fetch/ca-fetch.ts';
import { readPlatforms } from '../platform/store/store.ts';
import { MediaError } from './errors.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';

/** Что ждали от чужой стороны — им назван отказ по потолку ожидания. */
export type UpstreamSubject = 'image' | 'deck';

const TIMEOUT_TEXT = {
  image: 'media-upstream-timeout-image',
  deck: 'media-upstream-timeout-deck',
} as const satisfies Record<UpstreamSubject, string>;

/**
 * Общее для картинок и презентаций: куда панель ходит и как читает чужой ответ.
 *
 * Отдельный модуль, потому что дороги у двух режимов разные, а транспорт один:
 * тот же потолок чтения, тот же перевод отказа чужой стороны в человеческую
 * строку, тот же выбор активного контура и «своих» профилей эндпоинта. Две копии
 * этого кода разошлись бы на первой правке — например, в потолке ответа, — и
 * панель вела бы себя по-разному в двух режимах без всякой причины.
 */

export interface MediaDeps {
  appDataDir: string;
  store: AppStore;
  /**
   * Адрес звена ядра для запросов в контур (`ContourLinker.link`, метка `panelHopTag`, C3b):
   * ключ контура, маска, расход, бюджет и след — у звена, как у запросов CLI этого контура.
   * Не задан — дорога через контур отвечает отказом при отправке.
   */
  contourLink?: (platformId: string, fresh?: boolean) => Promise<CoreContourLinkReply>;
  /** Транспорт: и к звену, и к чужой ручке. Подставляется в тестах. */
  fetchImpl?: PlatformFetch;
  now?: () => Date;
  /**
   * Окружение процесса — им ищется системный браузер для печати PDF.
   * Подставляется в тестах: иначе «получится ли PDF» проверялось бы только на
   * машине, где браузер УЖЕ стоит, и вторая ветка обещания (названная причина)
   * не проверялась бы вовсе.
   */
  env?: NodeJS.ProcessEnv;
}

/** Сколько текста чужого ответа попадает в отказ. */
export const EXCERPT = 200;

/** Активный и включённый контур панели. */
export function activeContour(store: AppStore): Platform | undefined {
  const settings = store.getSettings();
  return readPlatforms(store).find(
    (platform) => platform.id === settings.activePlatformId && platform.enabled,
  );
}

/** Профили человека: порождённые контуром смотрят на наш же шлюз и не годятся. */
export function ownProfiles(store: AppStore): EndpointProfile[] {
  return store.getSettings().endpointProfiles.filter((profile) => !profile.ownerPlatformId);
}

/**
 * Цель запроса в контур через звено ядра: адрес ручки и заглушка ключа (настоящий ключ
 * подставляет звено). Ядро или звено не дали адрес — отказ словами ядра: 409, если дело в
 * контуре (выключен, звено его не приняло), 503 — если ядра нет.
 */
export async function contourTarget(
  deps: MediaDeps,
  contour: Platform,
  tail: string,
  fresh = false,
): Promise<{ url: string; headers: Record<string, string> }> {
  if (!deps.contourLink)
    throw new MediaError(503, serverText('media-core-not-connected'), undefined, {
      code: 'media-core-not-connected',
    });
  try {
    const link = await deps.contourLink(contour.id, fresh);
    return { url: `${link.baseUrl}/${tail}`, headers: { authorization: `Bearer ${link.key}` } };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const said = error instanceof Error ? error.message : String(error);
    // Без явного кода: слова ядра бывают и строкой `serverText` (ядра нет), и английским
    // отказом звена — маршрут найдёт код разбором и переведёт вложенную причину, если сможет.
    throw new MediaError(
      status === 404 || status === 409 ? 409 : 503,
      serverText('media-contour-link-failed', { contour: contour.title, reason: said }),
    );
  }
}

/**
 * POST в контур через звено. Заглушку отверг хост (401: метку сняли, хост сменился) — один
 * повтор с новой: на 401 работа наверху не случилась, и повтор её не удвоит.
 */
export async function askContour(
  deps: MediaDeps,
  contour: Platform,
  tail: string,
  body: unknown,
  timeoutMs: number,
  subject: UpstreamSubject,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as PlatformFetch);
  const first = await contourTarget(deps, contour, tail);
  const response = await askUpstream(fetchImpl, first.url, first.headers, body, timeoutMs, subject);
  if (response.status !== 401) return response;
  await response.body?.cancel().catch(() => undefined);
  const again = await contourTarget(deps, contour, tail, true);
  return askUpstream(fetchImpl, again.url, again.headers, body, timeoutMs, subject);
}

/** POST с потолком ожидания. Отказ транспорта переводится в причину. */
export async function askUpstream(
  fetchImpl: PlatformFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  subject: UpstreamSubject,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      const seconds = timeoutMs / 1_000;
      throw new MediaError(504, serverText(TIMEOUT_TEXT[subject], { seconds }), undefined, {
        code: TIMEOUT_TEXT[subject],
        params: { seconds },
      });
    }
    throw coded(
      new MediaError(502, `До адреса не дошли: ${String(error)}`),
      'media-upstream-unreachable',
      { reason: String(error) },
    );
  }
}

/** Ответ чужой стороны, прочитанный с потолком: тело бывает и мегабайтным. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();

  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new MediaError(
        502,
        `Ответ больше ${Math.round(maxBytes / (1024 * 1024))} МБ — панель его не собирает`,
      );
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/** Причина отказа чужой стороны словами: тело обрезано, секретов в нём нет. */
export function refusalOf(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : isRecord(parsed.error) && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : '';
    if (message) return `Ответ ${status}: ${message.slice(0, EXCERPT)}`;
  } catch {
    // Не JSON — в отказ уйдёт начало тела как есть.
  }
  const plain = body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT);
  return plain ? `Ответ ${status}: ${plain}` : `Ответ ${status} без тела`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

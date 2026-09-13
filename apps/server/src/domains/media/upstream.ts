import type { EndpointProfile, Platform } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from '../platform/ca-fetch.ts';
import { readPlatforms } from '../platform/store.ts';
import { MediaError } from './errors.ts';

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
   * Порт ЖИВОГО слушателя шлюза; 0 — шлюз не поднят. Спрашивается у слушателя, а
   * не у настроек: задуманный порт мог быть занят, и запрос ушёл бы чужому
   * процессу (та же ловушка, что закрыта в `apply/profile.ts`).
   */
  gatewayPort?: () => number;
  /** Транспорт: и к своему шлюзу, и к чужой ручке. Подставляется в тестах. */
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

/** Адрес своего шлюза для контура. Пусто — шлюз не поднят. */
export function gatewayUrl(deps: MediaDeps, contour: Platform, tail: string): string {
  const port = deps.gatewayPort?.() ?? 0;
  return port > 0 ? `http://127.0.0.1:${port}/${contour.id}/${tail}` : '';
}

/** POST с потолком ожидания. Отказ транспорта переводится в причину. */
export async function askUpstream(
  fetchImpl: PlatformFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  subject: string,
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
      throw new MediaError(
        504,
        `${subject} не пришло за ${timeoutMs / 1_000} с — панель не ждёт дольше`,
      );
    }
    throw new MediaError(502, `До адреса не дошли: ${String(error)}`);
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

import type { EndpointApiKind, EndpointProbeResult, EndpointProfile } from '@agentdeck/contracts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Проверка связи со своим эндпоинтом: панель спрашивает у адреса СПИСОК МОДЕЛЕЙ.
 *
 * Почему именно список, а не пробная генерация: список ничего не стоит и ничего
 * не расходует, а отвечает сразу на три вопроса — адрес жив, токен принят, какие
 * имена моделей на нём есть (их же панель подставит в поле «модель»). Пробная
 * генерация — отдельная кнопка и отдельное решение пользователя: она тратит
 * токены и лимиты, и делать её молча в фоне нельзя.
 *
 * БЕЗОПАСНОСТЬ: токен уходит ТОЛЬКО в заголовок (или, у Google, в квери) самого
 * запроса. Наружу и в лог возвращается адрес БЕЗ токена, а тело ошибки
 * обрезается — сервер эндпоинта вполне может отразить присланный ключ в тексте
 * ошибки, и такой ответ не должен осесть в интерфейсе целиком.
 */

/** Потолок ожидания ответа. Локальная модель поднимается небыстро, но не минуту. */
const PROBE_TIMEOUT_MS = 15_000;

/** Сколько символов чужого текста ошибки показываем (как в assistant-runner). */
const ERROR_BODY_LIMIT = 300;

export type ProbeFetch = typeof globalThis.fetch;

/** Адрес списка моделей для вида API. Базовый адрес берётся как есть, без догадок. */
export function endpointModelsUrl(baseUrl: string, apiKind: EndpointApiKind): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  // anthropic: базовый адрес — корень хоста, клиент сам дописывает `/v1/...`.
  if (apiKind === 'anthropic') return `${base}/v1/models`;
  // google: то же самое, версия входит в путь запроса, а не в базовый адрес.
  if (apiKind === 'google') return `${base}/v1beta/models`;
  // openai-compat: адрес уже включает версию (`.../v1`), список моделей рядом.
  return `${base}/models`;
}

/**
 * Разобрать адрес и убедиться, что это http(s). Прочие схемы (file:, ftp:) —
 * отказ ДО сети: панель не должна ходить по ним даже с ведома пользователя.
 */
export function parseEndpointUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Локальный ли адрес — у Gemini от этого зависит, допустим ли ему http. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
}

/** Имена моделей из ответа: три разные формы, каждая задокументирована вендором. */
function extractModels(payload: unknown, apiKind: EndpointApiKind): string[] {
  if (!payload || typeof payload !== 'object') return [];

  if (apiKind === 'google') {
    // Google: `{ models: [{ name: "models/gemini-3-flash" }] }` — префикс
    // `models/` служебный, в переменную модели идёт хвост.
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    return models
      .map((item) => (item as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''));
  }

  // anthropic и openai-compat: `{ data: [{ id: "..." }] }`.
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (item as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Проверить связь. Возвращает результат, а не бросает: недоступный адрес — это
 * нормальный ответ проверки, а не сбой панели.
 */
export async function probeEndpoint(
  profile: EndpointProfile,
  token: string | undefined,
  fetchImpl: ProbeFetch = globalThis.fetch,
): Promise<EndpointProbeResult> {
  const target = endpointModelsUrl(profile.baseUrl, profile.apiKind);
  const parsed = parseEndpointUrl(target);
  if (!parsed) {
    return {
      ok: false,
      url: profile.baseUrl,
      models: [],
      tokenSent: false,
      error: 'Адрес должен быть корректным http(s)-адресом.',
      messageCode: 'endpoint-base-url-invalid',
    };
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  let requestUrl = parsed.toString();
  const tokenSent = Boolean(token);

  if (token) {
    if (profile.apiKind === 'anthropic') {
      headers['x-api-key'] = token;
      headers['anthropic-version'] = '2023-06-01';
    } else if (profile.apiKind === 'google') {
      // Ключ — в квери. Строку с ключом держим локально: наружу отдаём `target`
      // (без ключа), в лог она тоже не попадает.
      const withKey = new URL(requestUrl);
      withKey.searchParams.set('key', token);
      requestUrl = withKey.toString();
    } else {
      headers.authorization = `Bearer ${token}`;
    }
  }

  try {
    const res = await fetchImpl(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, ERROR_BODY_LIMIT);
      } catch {
        detail = '';
      }
      return {
        ok: false,
        url: target,
        status: res.status,
        models: [],
        tokenSent,
        error: `Адрес ответил ${res.status}${detail ? `: ${detail}` : ''}`,
        messageCode: 'endpoint-probe-status' as const,
        // Разделитель уезжает ВНУТРИ значения, а не шаблоном: шаблон
        // (`{{status}}{{detail}}`) условий не знает, и при пустом теле «401: »
        // повисло бы двоеточием в никуда. Без этого клиент рисовал
        // «Адрес ответил 401Unauthorized» там, где запасная строка сервера
        // говорит «401: Unauthorized» (ревью Т0→Т13, находка лейна справки).
        params: { status: res.status, detail: detail ? `: ${detail}` : '' },
      };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      // Связь есть, но ответ не JSON — обычно перед эндпоинтом стоит страница
      // входа или прокси. Это не «список пуст», это другой ответ, так и говорим.
      return {
        ok: false,
        url: target,
        status: res.status,
        models: [],
        tokenSent,
        error: 'Ответ не является JSON — по адресу отвечает не модельный API.',
        messageCode: 'endpoint-probe-not-json',
      };
    }

    return {
      ok: true,
      url: target,
      status: res.status,
      models: extractModels(payload, profile.apiKind),
      tokenSent,
    };
  } catch (error) {
    // `AbortSignal.timeout` бросает TimeoutError — отличаем от «не достучались».
    // Свой текст пишется по коду, чужой (сообщение fetch) остаётся как есть:
    // переводить чужую строку нечем, а прятать её — прятать причину.
    if (error instanceof Error && error.name === 'TimeoutError') {
      const seconds = PROBE_TIMEOUT_MS / 1000;
      return {
        ok: false,
        url: target,
        models: [],
        tokenSent,
        error: serverText('endpoint-probe-timeout', { seconds }),
        messageCode: 'endpoint-probe-timeout' as const,
        params: { seconds },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, url: target, models: [], tokenSent, error: message };
  }
}

import type { NetFetch } from '../../platform/net/net.types.ts';
import type { ApiKeyKind, KeyedProbeReply, ProbeOutcome } from './api-key.types.ts';

/**
 * Проба адреса модели: СПИСОК МОДЕЛЕЙ (перенос `domains/endpoints/endpoint-probe` и исходов
 * `domains/platform/probe` панели, строки миграции 10:127, 10:140). Список ничего не стоит и не
 * тратит лимит, а отвечает на три вопроса: адрес жив, это модельный API, какие модели есть.
 *
 * Классы исходов (P111 — непрочитанное никогда не «нет»):
 * - 2xx + JSON со списком — каталог;
 * - 401/403 без ключа — адрес жив, каталог закрыт ключом;
 * - сеть, срок, 429/503/5xx, иной 4xx, HTML, не JSON, нет списка — БРОСОК с причиной: факт
 *   `unknown` с действием класса. Тело чужой ошибки в причину не берётся: шлюз вправе отразить
 *   в нём присланный ключ.
 */

/** Адрес списка моделей по виду API. Базовый адрес — как есть, без догадок. */
export function endpointModelsUrl(baseUrl: string, apiKind: ApiKeyKind): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (apiKind === 'anthropic') return `${base}/v1/models`;
  if (apiKind === 'google') return `${base}/v1beta/models`;
  return `${base}/models`;
}

/** http(s) — иначе отказ ДО сети: по `file:` и прочим схемам ядро не ходит. */
export function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Имена моделей ответа: три формы, каждая задокументирована вендором. */
export function extractModels(payload: unknown, apiKind: ApiKeyKind): string[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (apiKind === 'google') {
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) return undefined;
    return models
      .map((item) => (item as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''));
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  return data
    .map((item) => (item as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

/** Ошибка пробы с кодом: в причине факта — код и короткий текст, без тела ответа. */
export function probeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Разобрать ответ (общий для пробы без ключа и чтения через звено). `keyed` — ключ был: тогда
 * 401/403 — отказ ключа, а не «закрыто ключом».
 */
export function classifyReply(
  reply: KeyedProbeReply,
  isCatalog: (payload: unknown) => boolean,
  keyed: boolean,
): ProbeOutcome {
  const { status } = reply;
  if (status === 401 || status === 403) {
    if (!keyed) return { kind: 'locked', status };
    throw probeError('key-refused', `the key was refused: ${status}`);
  }
  if (status === 429 || status === 503 || status >= 500) {
    throw probeError('not-ready', `address answers ${status}: not ready`);
  }
  if (status >= 400) throw probeError('not-api', `address answers ${status}: not a model API`);
  if ((reply.contentType ?? '').includes('text/html')) {
    throw probeError('not-api', `address answers ${status} with an HTML page`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(reply.body) as unknown;
  } catch {
    throw probeError('garbage', `address answers ${status}, body is not JSON`);
  }
  if (!isCatalog(payload)) throw probeError('garbage', 'JSON without a model list');
  return { kind: 'catalog', status, payload };
}

/** Проба без ключа: только адрес и несекретные заголовки. */
export async function probeUnkeyed(args: {
  fetch: NetFetch;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  isCatalog: (payload: unknown) => boolean;
}): Promise<ProbeOutcome> {
  const parsed = parseHttpUrl(args.url);
  if (!parsed) throw probeError('bad-url', 'address is not an http(s) URL');
  let response: Response;
  try {
    response = await args.fetch(parsed.toString(), {
      method: 'GET',
      headers: args.headers,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw probeError('timeout', `no answer in ${args.timeoutMs} ms`);
    }
    throw error;
  }
  const body = await response.text().catch(() => '');
  return classifyReply(
    { status: response.status, body, contentType: response.headers.get('content-type') ?? '' },
    args.isCatalog,
    false,
  );
}

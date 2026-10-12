import type { ApiEndpoint, ApiHistoryEntry, ApiMethod } from '@entities/ApiExplorer';

/**
 * Черновик запроса вкладки «API» и всё, что из него собирается: адрес,
 * заголовки, тело. Отдельно от разметки — чтобы проверить сборку адреса и
 * заполнение из контракта без браузера.
 */

export interface KeyValueRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

export interface ApiDraft {
  method: ApiMethod;
  /** Путь эндпоинта с `{param}`; без эндпоинта — путь или полный адрес, как ввёл человек. */
  path: string;
  pathValues: Record<string, string>;
  query: KeyValueRow[];
  headers: KeyValueRow[];
  body: string;
}

let rowSeq = 0;
export const row = (name = '', value = '', enabled = true): KeyValueRow => ({
  id: `r${++rowSeq}`,
  name,
  value,
  enabled,
});

const asText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const JSON_TYPE = /[/+]json\b/i;

export const emptyDraft = (): ApiDraft => ({
  method: 'get',
  path: '',
  pathValues: {},
  query: [],
  headers: [],
  body: '',
});

/** Черновик по эндпоинту: примеры контракта (или запрос из Postman) — уже в полях. */
export function draftFromEndpoint(endpoint: ApiEndpoint): ApiDraft {
  const pathValues: Record<string, string> = {};
  const query: KeyValueRow[] = [];
  const headers: KeyValueRow[] = [];
  for (const param of endpoint.params) {
    const value = asText(param.example);
    if (param.in === 'path') pathValues[param.name] = value;
    // Необязательный параметр без примера — в списке, но выключен: уйдёт, только если его включить.
    else if (param.in === 'query')
      query.push(row(param.name, value, param.required || value !== ''));
    else headers.push(row(param.name, value, param.required || value !== ''));
  }
  for (const [name, value] of endpoint.preset?.headers ?? []) {
    if (!headers.some((item) => item.name.toLowerCase() === name.toLowerCase()))
      headers.push(row(name, value));
  }
  let body = endpoint.preset?.body ?? '';
  if (!body && endpoint.body?.example !== undefined) {
    body = JSON_TYPE.test(endpoint.body.contentType)
      ? JSON.stringify(endpoint.body.example, null, 2)
      : asText(endpoint.body.example);
  }
  if (endpoint.body && !headers.some((item) => item.name.toLowerCase() === 'content-type'))
    headers.push(row('Content-Type', endpoint.body.contentType));
  return {
    method: endpoint.method,
    path: endpoint.path,
    pathValues,
    query,
    headers,
    body,
  };
}

/** Маска секрета из истории — такой заголовок повторно не отправляем. */
export const isMasked = (value: string): boolean => value.includes('••••');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Адрес из истории, разложенный по пути эндпоинта: начало (сервер и префикс),
 * значения `{param}` и параметры запроса. Не подошёл к шаблону — `undefined`.
 */
function splitByTemplate(
  url: string,
  template: string,
): { prefix: string; values: Record<string, string>; query: [string, string][] } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const name = /^\{([^}]+)\}$/.exec(part)?.[1];
      if (name === undefined) return escapeRegExp(part);
      names.push(name);
      return '([^/]+)';
    })
    .join('');
  const match = new RegExp(`^(.*?)${pattern}/?$`).exec(parsed.pathname);
  if (!match) return undefined;
  const values: Record<string, string> = {};
  names.forEach((name, index) => (values[name] = decode(match[index + 2] ?? '')));
  return {
    prefix: `${parsed.origin}${match[1] ?? ''}`,
    values,
    query: [...parsed.searchParams.entries()],
  };
}

/**
 * Черновик из истории, заголовки без замаскированных. Запрос к эндпоинту
 * контракта раскладывается обратно по его пути: поля `{param}` и параметры
 * запроса снова заполнены и правятся как при выборе эндпоинта, а сервер, на
 * который запрос ушёл тогда, остаётся в пути. Иначе — полный адрес как был.
 */
export function draftFromHistory(entry: ApiHistoryEntry, endpoint?: ApiEndpoint): ApiDraft {
  const headers = entry.headers
    .filter(([, value]) => !isMasked(value))
    .map(([name, value]) => row(name, value));
  const split = endpoint ? splitByTemplate(entry.url, endpoint.path) : undefined;
  return {
    method: entry.method,
    path: split && endpoint ? `${split.prefix}${endpoint.path}` : entry.url,
    pathValues: split?.values ?? {},
    query: split ? split.query.map(([name, value]) => row(name, value)) : [],
    headers,
    body: entry.body ?? '',
  };
}

/** Подходит ли запрос из истории к пути эндпоинта — тогда повтор открывает этот эндпоинт. */
export const historyMatchesEndpoint = (entry: ApiHistoryEntry, endpoint: ApiEndpoint): boolean =>
  entry.method === endpoint.method && splitByTemplate(entry.url, endpoint.path) !== undefined;

export const isAbsoluteUrl = (value: string): boolean => /^https?:\/\//i.test(value.trim());

/** Имена параметров пути без значения — запрос с `{id}` в адресе не уйдёт. */
export function missingPathParams(draft: ApiDraft): string[] {
  return [...draft.path.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => !draft.pathValues[name]?.trim());
}

/** Итоговый адрес: база + путь с подставленными параметрами + включённые параметры запроса. */
export function buildUrl(baseUrl: string, draft: ApiDraft): string {
  const path = draft.path.trim().replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const value = draft.pathValues[name]?.trim();
    return value ? encodeURIComponent(value) : whole;
  });
  let url = path;
  if (!isAbsoluteUrl(path)) {
    const base = baseUrl.trim().replace(/\/+$/, '');
    url = `${base}${path.startsWith('/') || !path ? '' : '/'}${path}`;
  }
  const pairs = draft.query
    .filter((item) => item.enabled && item.name.trim())
    .map((item) => `${encodeURIComponent(item.name.trim())}=${encodeURIComponent(item.value)}`);
  if (pairs.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

export const headerPairs = (draft: ApiDraft): [string, string][] =>
  draft.headers
    .filter((item) => item.enabled && item.name.trim())
    .map((item): [string, string] => [item.name.trim(), item.value]);

/** JSON красиво, если это JSON; иначе как пришло. */
export function prettyBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}

/** Тело запроса — валидный JSON? `undefined`, если да или тело пустое; иначе текст ошибки. */
export function jsonProblem(body: string, contentType: string | undefined): string | undefined {
  if (!body.trim() || !contentType || !JSON_TYPE.test(contentType)) return undefined;
  try {
    JSON.parse(body);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export const contentTypeOf = (draft: ApiDraft): string | undefined =>
  draft.headers.find((item) => item.enabled && item.name.trim().toLowerCase() === 'content-type')
    ?.value;

export function statusTone(status: number): 'success' | 'info' | 'warning' | 'danger' {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  return 'success';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface EndpointGroup {
  tag: string;
  endpoints: ApiEndpoint[];
}

/** Поиск по методу, пути, описанию и operationId; группы — по первому тегу, в порядке контракта. */
export function groupEndpoints(endpoints: ApiEndpoint[], search: string): EndpointGroup[] {
  const needle = search.trim().toLowerCase();
  const groups = new Map<string, ApiEndpoint[]>();
  for (const endpoint of endpoints) {
    if (needle) {
      const hay = [endpoint.method, endpoint.path, endpoint.summary, endpoint.operationId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!needle.split(/\s+/).every((word) => hay.includes(word))) continue;
    }
    const tag = endpoint.tags[0] ?? '';
    groups.set(tag, [...(groups.get(tag) ?? []), endpoint]);
  }
  return [...groups.entries()].map(([tag, list]) => ({ tag, endpoints: list }));
}

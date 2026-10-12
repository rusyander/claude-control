import { API_METHODS } from '@agentdeck/contracts/api-explorer';
import type {
  ApiEndpoint,
  ApiMethod,
  ApiParam,
  ApiSpec,
  ApiSpecWarning,
} from '@agentdeck/contracts';
import { isNode, type JsonNode } from './api-explorer.types.ts';

/**
 * Коллекция Postman v2.0/v2.1 → те же эндпоинты, что из OpenAPI. Папки — теги,
 * переменные коллекции подставлены, `:id` в пути — параметр `{id}`. Начало
 * адреса (`{{baseUrl}}` или `https://host`) уходит в `servers`: базовый адрес
 * человек выбирает сам, как у контракта. Схем ответов у Postman нет — сверки
 * со схемой у такого запроса не будет.
 */

const MAX_ENDPOINTS = 2000;
const VAR = /\{\{\s*([^}\s]+)\s*\}\}/g;

export function isPostmanCollection(doc: JsonNode): boolean {
  const info = doc.info;
  return (
    isNode(info) &&
    Array.isArray(doc.item) &&
    (typeof info._postman_id === 'string' ||
      (typeof info.schema === 'string' && info.schema.includes('getpostman.com')))
  );
}

function variablesOf(list: unknown): Map<string, string> {
  const vars = new Map<string, string>();
  if (!Array.isArray(list)) return vars;
  for (const item of list) {
    if (isNode(item) && typeof item.key === 'string' && item.disabled !== true)
      vars.set(item.key, item.value === undefined ? '' : String(item.value));
  }
  return vars;
}

interface Walk {
  vars: Map<string, string>;
  servers: Set<string>;
  endpoints: ApiEndpoint[];
  ids: Map<string, number>;
  auth: Set<string>;
  bodies: number;
}

const fill = (text: string, vars: Map<string, string>): string =>
  text.replace(VAR, (whole, name: string) => vars.get(name) ?? whole);

/** Адрес запроса → начало (сервер) и путь с `{param}`. */
function splitUrl(rawUrl: string): { server?: string; path: string; query: [string, string][] } {
  let rest = rawUrl.trim();
  let server: string | undefined;
  const absolute = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(rest);
  if (absolute) {
    server = absolute[1];
    rest = absolute[2] ?? '';
  } else {
    // `{{baseUrl}}/users` — переменная, которой нет в коллекции: это и есть сервер.
    const lead = /^(\{\{[^}]+\}\}[^/?#]*)(.*)$/.exec(rest);
    if (lead) {
      server = lead[1];
      rest = lead[2] ?? '';
    }
  }
  const [pathPart = '', search = ''] = rest.split('?', 2);
  const path = `/${pathPart.replace(/^\/+/, '')}`.replace(/\/:([A-Za-z_][\w-]*)/g, '/{$1}');
  const query = search
    .split('&')
    .filter(Boolean)
    .map((pair): [string, string] => {
      const [name = '', value = ''] = pair.split('=', 2);
      return [decodeSafe(name), decodeSafe(value)];
    });
  return { ...(server ? { server } : {}), path, query };
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Postman хранит хост и путь то строкой, то списком частей. */
function joined(value: unknown, separator: string): string {
  if (Array.isArray(value)) return value.join(separator);
  return typeof value === 'string' ? value : '';
}

function rawUrlOf(url: unknown): string | undefined {
  if (typeof url === 'string') return url;
  if (!isNode(url)) return undefined;
  if (typeof url.raw === 'string') return url.raw;
  const host = joined(url.host, '.');
  const path = joined(url.path, '/');
  const protocol = typeof url.protocol === 'string' ? `${url.protocol}://` : '';
  return `${protocol}${host}/${path}`;
}

/** Bearer и API-ключ в заголовке — переносим; прочие виды — в предупреждение. */
function authHeader(
  auth: unknown,
  vars: Map<string, string>,
  walk: Walk,
): [string, string] | undefined {
  if (!isNode(auth) || typeof auth.type !== 'string' || auth.type === 'noauth') return undefined;
  const fields = new Map<string, string>();
  const list = auth[auth.type];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (isNode(item) && typeof item.key === 'string')
        fields.set(item.key, fill(String(item.value ?? ''), vars));
    }
  }
  if (auth.type === 'bearer') return ['Authorization', `Bearer ${fields.get('token') ?? ''}`];
  if (auth.type === 'apikey' && (fields.get('in') ?? 'header') === 'header')
    return [fields.get('key') ?? 'X-API-Key', fields.get('value') ?? ''];
  walk.auth.add(auth.type);
  return undefined;
}

function readRequest(item: JsonNode, tags: string[], inheritedAuth: unknown, walk: Walk): void {
  // Короткая запись запроса — просто адрес строкой, метод тогда GET.
  const request: JsonNode | undefined =
    typeof item.request === 'string' ? { url: item.request, method: 'GET' } : undefined;
  if (!request && !isNode(item.request)) return;
  return readRequestNode(item, request ?? (item.request as JsonNode), tags, inheritedAuth, walk);
}

function readRequestNode(
  item: JsonNode,
  request: JsonNode,
  tags: string[],
  inheritedAuth: unknown,
  walk: Walk,
): void {
  const method = String(request.method ?? 'GET').toLowerCase();
  if (!(API_METHODS as readonly string[]).includes(method)) return;
  const rawUrl = rawUrlOf(request.url);
  if (rawUrl === undefined) return;
  const { server, path, query } = splitUrl(fill(rawUrl, walk.vars));
  // Неразрешённое `{{baseUrl}}` базовым адресом не предложишь — только настоящий адрес.
  if (server && /^https?:\/\//i.test(server)) walk.servers.add(server);

  const params: ApiParam[] = [];
  const pathVars =
    isNode(request.url) && Array.isArray(request.url.variable) ? request.url.variable : [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1] ?? '';
    const declared = pathVars.find((item) => isNode(item) && item.key === name);
    const value =
      isNode(declared) && declared.value !== undefined ? String(declared.value) : undefined;
    params.push({ name, in: 'path', required: true, ...(value ? { example: value } : {}) });
  }
  for (const [name, value] of query)
    params.push({ name, in: 'query', required: false, example: value });

  const headers: [string, string][] = [];
  if (Array.isArray(request.header)) {
    for (const header of request.header) {
      if (isNode(header) && typeof header.key === 'string' && header.disabled !== true)
        headers.push([header.key, fill(String(header.value ?? ''), walk.vars)]);
    }
  }
  const auth = authHeader(request.auth ?? inheritedAuth, walk.vars, walk);
  if (auth && !headers.some(([name]) => name.toLowerCase() === auth[0].toLowerCase()))
    headers.push(auth);

  let body: string | undefined;
  let contentType: string | undefined;
  const rawBody = request.body;
  if (isNode(rawBody) && rawBody.disabled !== true) {
    if (rawBody.mode === 'raw' && typeof rawBody.raw === 'string') {
      body = fill(rawBody.raw, walk.vars);
      const options =
        isNode(rawBody.options) && isNode(rawBody.options.raw) ? rawBody.options.raw : {};
      const language = typeof options.language === 'string' ? options.language : '';
      contentType =
        language === 'json' || /^\s*[{[]/.test(body) ? 'application/json' : 'text/plain';
    } else if (rawBody.mode === 'urlencoded' && Array.isArray(rawBody.urlencoded)) {
      body = rawBody.urlencoded
        .filter((field): field is JsonNode => isNode(field) && field.disabled !== true)
        .map(
          (field) =>
            `${encodeURIComponent(String(field.key ?? ''))}=${encodeURIComponent(fill(String(field.value ?? ''), walk.vars))}`,
        )
        .join('&');
      contentType = 'application/x-www-form-urlencoded';
    } else if (rawBody.mode) walk.bodies++;
  }
  if (contentType && !headers.some(([name]) => name.toLowerCase() === 'content-type'))
    headers.push(['Content-Type', contentType]);

  const upper = method.toUpperCase();
  const baseId = `${upper} ${path}`;
  const seen = walk.ids.get(baseId) ?? 0;
  walk.ids.set(baseId, seen + 1);
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  walk.endpoints.push({
    // Один и тот же запрос в коллекции бывает дважды (с разными телами) — id различаем.
    id: seen === 0 ? baseId : `${baseId} #${seen + 1}`,
    method: method as ApiMethod,
    path,
    ...(name ? { summary: name } : {}),
    ...(typeof request.description === 'string' && request.description.trim()
      ? { description: request.description.trim() }
      : {}),
    tags: tags.length > 0 ? [tags.join(' / ')] : [],
    params,
    ...(body !== undefined && contentType
      ? { body: { contentType, required: false, example: body } }
      : {}),
    responses: [],
    preset: { headers, ...(body !== undefined ? { body } : {}) },
  });
}

function walkItems(items: unknown[], tags: string[], auth: unknown, walk: Walk): void {
  for (const item of items) {
    if (walk.endpoints.length >= MAX_ENDPOINTS) return;
    if (!isNode(item)) continue;
    if (Array.isArray(item.item)) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      walkItems(item.item, name ? [...tags, name] : tags, item.auth ?? auth, walk);
    } else readRequest(item, tags, auth, walk);
  }
}

export function parsePostman(doc: JsonNode, sourceId: string): ApiSpec {
  const info = isNode(doc.info) ? doc.info : {};
  const walk: Walk = {
    vars: variablesOf(doc.variable),
    servers: new Set(),
    endpoints: [],
    ids: new Map(),
    auth: new Set(),
    bodies: 0,
  };
  walkItems(Array.isArray(doc.item) ? doc.item : [], [], doc.auth, walk);
  const warnings: ApiSpecWarning[] = [];
  if (walk.endpoints.length >= MAX_ENDPOINTS)
    warnings.push({ code: 'truncated', count: MAX_ENDPOINTS });
  for (const type of walk.auth) warnings.push({ code: 'postman-auth', detail: type });
  if (walk.bodies > 0) warnings.push({ code: 'postman-body', count: walk.bodies });
  return {
    sourceId,
    title: typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'Postman',
    format: 'postman',
    servers: [...walk.servers],
    endpoints: walk.endpoints,
    warnings,
  };
}

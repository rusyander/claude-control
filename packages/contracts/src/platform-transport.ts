import { object, string, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Как запрос доезжает до контура: адрес, заголовок ключа, лишние заголовки и
 * параметры строки запроса (аудит DRV-04/05).
 *
 * До этого модуля всё это было зашито одинаково для любого контура:
 * `Authorization: Bearer` и `/v1`, приклеенный к адресу без версии в конце.
 * Верно для платформа компании и половины совместимых шлюзов — и молча неверно для
 * остальных: Azure OpenAI ждёт ключ в `api-key` и `?api-version=`, Gemini
 * отвечает на `…/v1beta/openai/models` (панель просила `…/v1beta/openai/v1/models`),
 * а параметр в самом адресе оказывался ПОСЛЕ дописанного пути. Каждый такой
 * контур отвечал 401 или 404, который человек читает как «ключ плохой».
 *
 * Живёт в контрактах, потому что ответ нужен обоим берегам: сервер по нему
 * ходит, а форма подключения показывает человеку ИТОГОВЫЙ адрес до сохранения —
 * две сборки одного адреса разошлись бы ровно там, где их не видно.
 *
 * Ключа здесь нет ни в каком виде. Заголовок ключа назначается, а значение
 * подставляет сервер из зашифрованного хранилища; имена, под которыми обычно
 * едет секрет, в лишних заголовках и параметрах отвергаются — иначе ключ,
 * вписанный «для проверки», лёг бы открытым текстом в настройки и в экспорт.
 */

/**
 * - `auto` — `/v1` дописывается, если в пути адреса нет сегмента версии
 *   (`/v1`, `/v4`, `/v1beta`) НИ В ОДНОМ месте: `…/v1beta/openai` уже с версией;
 * - `as-is` — путь адреса берётся как есть (Azure `…/openai/deployments/<имя>`).
 */
export const platformVersionModes = ['auto', 'as-is'] as const;

export type PlatformVersionMode = (typeof platformVersionModes)[number];

export const platformTransportSchema = object({
  /**
   * Заголовок ключа. Пусто — как объявил драйвер (`Authorization: Bearer`).
   * Заданный — ключ уходит в него со схемой `authScheme`, а без схемы голым.
   */
  authHeader: string().default(''),
  /** Слово перед ключом (`Bearer`, `Token`). Читается только при `authHeader`. */
  authScheme: string().default(''),
  version: zodEnum(platformVersionModes).default('auto'),
  /** Параметры каждого запроса: `api-version=2024-10-21&tenant=x`. */
  query: string().default(''),
  /** Лишние заголовки, по одному в строке: `X-Tenant: research`. */
  headers: string().default(''),
});

export type PlatformTransport = Infer<typeof platformTransportSchema>;

export function defaultPlatformTransport(): PlatformTransport {
  return { authHeader: '', authScheme: '', version: 'auto', query: '', headers: '' };
}

export type PlatformTransportField = 'authHeader' | 'authScheme' | 'query' | 'headers';

export type PlatformTransportErrorCode =
  /** Имя заголовка или слово схемы не токен HTTP. */
  | 'token'
  /**
   * Строка заголовков не вида `Имя: значение`, или параметр без имени. Предмет —
   * НОМЕР строки или параметра, а не текст: строка без двоеточия чаще всего и
   * есть вставленный ключ.
   */
  | 'line'
  /** Под этим именем обычно едет секрет — ключ сюда не кладётся. */
  | 'secret'
  /** Заголовок ставит сама панель: тип тела, `accept`, заголовок ключа. */
  | 'reserved';

export interface PlatformTransportError {
  field: PlatformTransportField;
  code: PlatformTransportErrorCode;
  /** Что именно не прошло — имя или номер строки, но никогда не значение. */
  subject: string;
}

const HTTP_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Имена заголовков, в которых у известных шлюзов едет ключ или сессия. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
]);

/** Заголовки, которые панель ставит сама, и перебить их строкой нельзя. */
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'content-length', 'host']);

const SECRET_QUERY = /^(key|api[-_]?key|access[-_]?token|token|secret|password|sig|signature)$/i;

const VERSION_SEGMENT = /\/v\d+[a-z0-9]*(\/|$)/i;

// Пакет собирается без DOM и без типов Node (`lib: ES2023`): контракт не
// привязан ни к одному берегу. `URL` при этом есть у обоих, где модуль
// исполняется, — у Node и у браузера, — поэтому берётся с `globalThis` под
// узким описанием ровно того, что здесь нужно.
interface UrlLike {
  protocol: string;
  pathname: string;
  hash: string;
  searchParams: {
    set(name: string, value: string): void;
    append(name: string, value: string): void;
  };
  toString(): string;
}

const runtime = globalThis as unknown as {
  URL: new (input: string) => UrlLike;
  URLSearchParams: new (input: string) => Iterable<[string, string]>;
};

/** Заголовок ключа, который реально уйдёт: свой или драйверный по умолчанию. */
function authHeaderOf(transport: PlatformTransport, driverHeader: string): string {
  return (transport.authHeader.trim() || driverHeader).toLowerCase();
}

/**
 * Лишние заголовки из текста. Имена приводятся к нижнему регистру: `X-Tenant`
 * и `x-tenant` — один заголовок, и второй молча перебил бы первый.
 */
export function parseTransportHeaders(
  text: string,
  driverAuthHeader = 'authorization',
  authHeader = '',
): { headers: Record<string, string>; errors: PlatformTransportError[] } {
  const headers: Record<string, string> = {};
  const errors: PlatformTransportError[] = [];
  const auth = (authHeader.trim() || driverAuthHeader).toLowerCase();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    const value = colon > 0 ? line.slice(colon + 1).trim() : '';
    if (!name || !value) {
      errors.push({ field: 'headers', code: 'line', subject: String(index + 1) });
      continue;
    }
    const lower = name.toLowerCase();
    // Имя с пробелом — тоже номер, а не текст: `Bearer sk-…: x` назвал бы ключ.
    if (!HTTP_TOKEN.test(name)) {
      errors.push({ field: 'headers', code: 'line', subject: String(index + 1) });
    } else if (SECRET_HEADERS.has(lower) || lower === auth) {
      errors.push({ field: 'headers', code: 'secret', subject: name });
    } else if (RESERVED_HEADERS.has(lower)) {
      errors.push({ field: 'headers', code: 'reserved', subject: name });
    } else headers[lower] = value;
  }
  return { headers, errors };
}

/** Параметры строки запроса из текста; ведущий `?` допускается. */
export function parseTransportQuery(text: string): {
  pairs: Array<[string, string]>;
  errors: PlatformTransportError[];
} {
  const pairs: Array<[string, string]> = [];
  const errors: PlatformTransportError[] = [];
  const body = text.trim().replace(/^\?/, '');
  if (!body) return { pairs, errors };
  let position = 0;
  for (const [name, value] of new runtime.URLSearchParams(body)) {
    position += 1;
    if (!name.trim()) errors.push({ field: 'query', code: 'line', subject: String(position) });
    else if (SECRET_QUERY.test(name.trim())) {
      errors.push({ field: 'query', code: 'secret', subject: name });
    } else pairs.push([name.trim(), value]);
  }
  return { pairs, errors };
}

/** Все отказы настройки; пусто — годится. */
export function platformTransportErrors(
  transport: PlatformTransport,
  driverAuthHeader = 'authorization',
): PlatformTransportError[] {
  const errors: PlatformTransportError[] = [];
  const authHeader = transport.authHeader.trim();
  const authScheme = transport.authScheme.trim();
  if (authHeader && !HTTP_TOKEN.test(authHeader)) {
    errors.push({ field: 'authHeader', code: 'token', subject: authHeader });
  } else if (authHeader && RESERVED_HEADERS.has(authHeader.toLowerCase())) {
    errors.push({ field: 'authHeader', code: 'reserved', subject: authHeader });
  }
  if (authScheme && !HTTP_TOKEN.test(authScheme)) {
    errors.push({ field: 'authScheme', code: 'token', subject: authScheme });
  }
  errors.push(...parseTransportHeaders(transport.headers, driverAuthHeader, authHeader).errors);
  errors.push(...parseTransportQuery(transport.query).errors);
  return errors;
}

/**
 * Адрес запроса к контуру. `undefined` — базовый адрес не http(s).
 *
 * Собирается через `URL`, а не склейкой строк: склейка дописывала путь ПОСЛЕ
 * строки запроса (`…?api-version=x/v1/models`). Параметры самого адреса
 * сохраняются, параметры настройки ставятся поверх них, а параметры пути
 * (`sessions/<id>?agent=`) добавляются к обоим.
 */
export function platformRequestUrl(
  baseUrl: string,
  transport: PlatformTransport,
  path: string,
): string | undefined {
  let url: UrlLike;
  try {
    url = new runtime.URL(baseUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const base = url.pathname.replace(/\/+$/, '');
  const root =
    transport.version === 'auto' && !VERSION_SEGMENT.test(`${base}/`) ? `${base}/v1` : base;
  const mark = path.indexOf('?');
  const ownPath = (mark < 0 ? path : path.slice(0, mark)).replace(/^\/+/, '');
  const ownQuery = mark < 0 ? '' : path.slice(mark + 1);

  url.pathname = `${root}/${ownPath}`;
  url.hash = '';
  for (const [name, value] of parseTransportQuery(transport.query).pairs) {
    url.searchParams.set(name, value);
  }
  for (const [name, value] of new runtime.URLSearchParams(ownQuery))
    url.searchParams.append(name, value);
  return url.toString();
}

/**
 * Заголовки запроса к контуру. Порядок сборки — защита, а не вкус: лишние
 * заголовки кладутся ПЕРВЫМИ, и ни `accept`, ни заголовок ключа строкой из
 * настройки не перебиваются, даже если отказ формы кто-то обошёл PATCH-ем.
 */
export function platformRequestHeaders(
  transport: PlatformTransport,
  driverAuth: { header: string; scheme: string },
  token: string | undefined,
): Record<string, string> {
  const own = transport.authHeader.trim();
  const header = authHeaderOf(transport, driverAuth.header);
  const scheme = own ? transport.authScheme.trim() : driverAuth.scheme;
  const { headers } = parseTransportHeaders(transport.headers, driverAuth.header, own);
  return {
    ...headers,
    accept: 'application/json',
    ...(token ? { [header]: scheme ? `${scheme} ${token}` : token } : {}),
  };
}

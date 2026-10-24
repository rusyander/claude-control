/**
 * Подпись решений ключом телефона — общая часть телефона и сервера.
 *
 * Зачем. Ворота «только человек» (`human-only.ts`) узнают окно браузера по
 * процессу, но правка фронтенда исполняется В ЭТОМ ЖЕ окне и проходит их как
 * человек. Ключ, созданный и лежащий на телефоне, такой правке недоступен:
 * решение, подписанное им, — единственное доказательство, которое не живёт на
 * этой машине. Режим «решения только с подписью телефона» включает человек на
 * телефоне; выключен — всё идёт как раньше.
 *
 * Модуль чистый — ни импортов, ни zod: телефон берёт его значения через Metro
 * (`VALUE_MODULES`), сервер — под `--experimental-strip-types`. Хэш и подпись
 * делает каждая сторона своим (на телефоне `@noble/*`, на сервере `node:crypto`),
 * здесь — только то, в чём обе обязаны совпасть байт в байт: какие маршруты
 * подписываются, когда решение «разрешающее», и точный текст подписи.
 */

/** Заголовок с подписью: `v1;device=…;nonce=…;time=…;sig=…`. */
export const SIGNATURE_HEADER = 'x-agentdeck-signature';

/** Первая строка подписываемого текста — подпись другого назначения сюда не подойдёт. */
export const SIGNATURE_DOMAIN = 'agentdeck-signed/v1';

/** Насколько часы телефона могут разойтись с часами компьютера. */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

/** Сколько помнится одноразовое число: дольше окна часов — повтор не пролезет на его краю. */
export const SIGNATURE_NONCE_TTL_MS = 10 * 60_000;

/**
 * Маршруты решений, где разрешение требует подписи, когда режим включён.
 * Шаблон — как у Fastify (`routeOptions.url`), метод — первым словом: сервер
 * судит по нему, телефон по нему же решает, подписывать ли запрос.
 */
export const SIGNED_DECISION_ROUTES = [
  'POST /api/chat/deferred/:id/decision',
  'POST /api/chat/:chatId/permission-decision',
  'POST /api/chat/:chatId/branch-decision',
  'POST /api/chat/:chatId/auto-approve',
  'POST /api/outside/asks/:id/answer',
  'POST /api/provider-chat/chats/:id/permissions/:askId',
  // Карточка агента панели: одобренная, она исполняет действие панели.
  'POST /api/agent/pending/:id',
  'POST /api/chat/send',
  'POST /api/phone-signing/mode',
  'POST /api/phone-signing/devices',
] as const;

export type SignedDecisionRoute = (typeof SIGNED_DECISION_ROUTES)[number];

export type SignatureClass = 'free' | 'signed';

const field = (body: unknown, key: string): unknown =>
  body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;

/**
 * Нужна ли решению подпись. Запрет, «стоп» и выключение — свободны: ужесточение
 * доказательств не требует, и отказ с телефона, из окна или Telegram должен
 * проходить всегда. Всё, что не РОВНО запрет, — подписывается: непонятное тело
 * не должно оказаться свободным.
 *
 * `send` подписывается при `fullAccess` или `autoApprove`: телефон подписывает
 * такую отправку всегда, а сервер требует подпись, только если отправка
 * ослабляет чат (`routes/phone-signing-routes/phone-signing-gate.ts`) — повтор уже действующего положения
 * ничего не разрешает.
 */
export function signatureClass(route: string, body: unknown): SignatureClass {
  switch (route) {
    case 'POST /api/chat/deferred/:id/decision':
    case 'POST /api/chat/:chatId/permission-decision':
    case 'POST /api/outside/asks/:id/answer':
      return field(body, 'behavior') === 'deny' && field(body, 'answers') === undefined
        ? 'free'
        : 'signed';
    case 'POST /api/chat/:chatId/branch-decision':
      return field(body, 'choice') === 'stop' ? 'free' : 'signed';
    case 'POST /api/chat/:chatId/auto-approve':
      return field(body, 'enabled') === true ? 'signed' : 'free';
    case 'POST /api/provider-chat/chats/:id/permissions/:askId':
      return field(body, 'decision') === 'deny' ? 'free' : 'signed';
    case 'POST /api/agent/pending/:id':
      return field(body, 'decision') === 'reject' ? 'free' : 'signed';
    case 'POST /api/chat/send':
      return field(body, 'fullAccess') === true || field(body, 'autoApprove') === true
        ? 'signed'
        : 'free';
    case 'POST /api/phone-signing/mode':
    case 'POST /api/phone-signing/devices':
      return 'signed';
    default:
      return 'free';
  }
}

/** Сегмент адреса так, как его отдаёт Fastify в `params`; кривой — как есть. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface SignedRouteMatch {
  route: SignedDecisionRoute;
  params: Record<string, string>;
}

/**
 * Какой маршрут решения стоит за адресом запроса (`/api/...`, строка запроса
 * отбрасывается). Телефон зовёт это до отправки: адрес у него конкретный, а
 * подпись берётся по шаблону — тому же, что сервер видит в `routeOptions.url`.
 */
export function matchSignedRoute(method: string, url: string): SignedRouteMatch | undefined {
  const [path = url] = url.split('?', 1);
  const parts = path.split('/');
  for (const route of SIGNED_DECISION_ROUTES) {
    const [routeMethod, pattern = ''] = route.split(' ');
    if (routeMethod !== method.toUpperCase()) continue;
    const want = pattern.split('/');
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const same = want.every((piece, index) => {
      const actual = parts[index] ?? '';
      if (piece.startsWith(':')) {
        if (!actual) return false;
        params[piece.slice(1)] = decodeSegment(actual);
        return true;
      }
      return piece === actual;
    });
    if (same) return { route, params };
  }
  return undefined;
}

/**
 * JSON с ключами по алфавиту на любой глубине. Обе стороны строят текст тела
 * из РАЗОБРАННОГО значения, а не из байтов запроса: порядок полей и пробелы
 * у разных JSON-библиотек разные, смысл — один.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Что из запроса подписывается: параметры пути и тело. Пустое тело — `null` у обеих сторон. */
export function signedPayloadText(params: Record<string, string>, body: unknown): string {
  return canonicalJson({ params, body: body ?? null });
}

export interface SignedMessageParts {
  /** Номер машины панели — подпись для другого компьютера здесь не подойдёт. */
  panel: string;
  device: string;
  route: string;
  /** sha256 от `signedPayloadText`, 64 шестнадцатеричных знака. */
  payloadHash: string;
  nonce: string;
  time: number;
}

/** Подписываемый текст. Строки через LF, без хвостового перевода строки. */
export function buildSignedMessage(parts: SignedMessageParts): string {
  return [
    SIGNATURE_DOMAIN,
    `panel=${parts.panel}`,
    `device=${parts.device}`,
    `route=${parts.route}`,
    `payload=${parts.payloadHash}`,
    `nonce=${parts.nonce}`,
    `time=${parts.time}`,
  ].join('\n');
}

export interface SignatureHeader {
  device: string;
  nonce: string;
  time: number;
  sig: string;
}

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

export function formatSignatureHeader(header: SignatureHeader): string {
  return `v1;device=${header.device};nonce=${header.nonce};time=${header.time};sig=${header.sig}`;
}

/** Разбор заголовка; любое отклонение от формы — `undefined`, а не догадка. */
export function parseSignatureHeader(raw: unknown): SignatureHeader | undefined {
  if (typeof raw !== 'string' || raw.length > 600) return undefined;
  const [version, ...pairs] = raw.trim().split(';');
  if (version !== 'v1' || pairs.length !== 4) return undefined;
  const values = new Map<string, string>();
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) return undefined;
    const key = pair.slice(0, at);
    if (values.has(key)) return undefined;
    values.set(key, pair.slice(at + 1));
  }
  const device = values.get('device') ?? '';
  const nonce = values.get('nonce') ?? '';
  const sig = values.get('sig') ?? '';
  const timeText = values.get('time') ?? '';
  if (!TOKEN.test(device) || !TOKEN.test(nonce) || !TOKEN.test(sig)) return undefined;
  if (!/^\d{1,16}$/.test(timeText)) return undefined;
  return { device, nonce, time: Number(timeText), sig };
}

/**
 * Текст набора устройств для включения режима: телефон хэширует то, что
 * ПОКАЗАЛ человеку, сервер — то, что у него сейчас. Не совпало — между экраном
 * телефона и включением кто-то добавил ключ.
 */
export function devicesSetText(devices: readonly { id: string; publicKey: string }[]): string {
  return [...devices]
    .map((device) => `${device.id}:${device.publicKey}`)
    .sort()
    .join('\n');
}

/** Отпечаток ключа для глаз: первые 8 байт sha256 открытого ключа, четвёрками. */
export function formatFingerprint(sha256Hex: string): string {
  return (
    sha256Hex
      .slice(0, 16)
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join(' ') ?? ''
  );
}

/** Номер устройства — из ключа, а не выдан сервером: телефон знает его до привязки. */
export function deviceIdOf(publicKeySha256Hex: string): string {
  return publicKeySha256Hex.slice(0, 16).toLowerCase();
}

/** UTF-8 без `TextEncoder`: в Hermes его может не быть, а байты обязаны совпасть. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url без `=` — ключи и подписи в заголовке и JSON. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63]! + B64[(triple >> 12) & 63]!;
    if (index + 1 < bytes.length) out += B64[(triple >> 6) & 63]!;
    if (index + 2 < bytes.length) out += B64[triple & 63]!;
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Коды отказа — их видит человек, текст у каждого свой. */
export type SignatureRefusal =
  'required' | 'lever' | 'invalid' | 'revoked' | 'stale' | 'replayed' | 'no-device';

/** Ответ `GET /api/phone-signing`. */
export interface PhoneSigningDevice {
  id: string;
  label: string;
  publicKey: string;
  fingerprint: string;
  boundAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface PhoneSigningView {
  enabled: boolean;
  enabledAt?: string;
  /** Номер машины — входит в подпись; телефон берёт его отсюда при привязке. */
  machineId: string;
  devices: PhoneSigningDevice[];
  /** Файл режима — его удаление и есть восстановление без телефона. */
  storePath: string;
}

export interface PhoneSigningBindBody {
  label: string;
  publicKey: string;
}

export interface PhoneSigningModeBody {
  enabled: boolean;
  /** sha256 hex от `devicesSetText` активных устройств — только при включении. */
  devicesHash?: string;
}

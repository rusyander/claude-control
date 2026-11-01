import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeWrite } from '@agentdeck/contracts/core/forge';
import { ABSENT } from '../../lib/facts/read-fact.ts';
import type { ForgeAccess, ForgeCall, ForgeReply } from './forge.types.ts';

/**
 * Один запрос к форжу и перевод исхода в факт (01 §Facts, P44): 2xx с разобранным телом —
 * значение; 404 на чтении по id — «нет»; 5xx, срок, обрыв, мусор вместо JSON, 401/403 —
 * `unknown` с причиной, никогда «нет»: «форж не ответил» и «MR нет» ведут к разным решениям.
 * Причина называет метод, путь и код, но не значение доступа и не тело запроса.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT = 2_000_000;

/** Заголовки доступа: у GitLab свой `PRIVATE-TOKEN`, у GitHub `Bearer`. */
function authHeaders(access: ForgeAccess, token: string): Record<string, string> {
  return access.project.kind === 'github'
    ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
    : { 'private-token': token };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    return [error.message, code ?? cause].filter(Boolean).join(' ');
  }
  return String(error);
}

export async function forgeCall(
  access: ForgeAccess,
  apiRoot: string,
  call: ForgeCall,
): Promise<ForgeReply> {
  const where = `${call.method} ${call.url.startsWith('http') ? new URL(call.url).pathname : call.url}`;
  if (!access.token)
    return {
      kind: 'unknown',
      reason: `${where}: ${access.tokenProblem ?? `no ${access.project.kind} credential`}`,
    };
  const timeoutMs = access.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
  let response: Response;
  let text: string;
  try {
    response = await access.fetch(
      call.url.startsWith('http') ? call.url : `${apiRoot}${call.url}`,
      {
        method: call.method,
        headers: {
          ...authHeaders(access, access.token),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    text = await response.text();
  } catch (error) {
    return { kind: 'unknown', reason: `${where}: ${describe(error)}` };
  }
  if (response.status >= 500)
    return { kind: 'unknown', reason: `${where}: http ${response.status}` };
  if (response.status === 401 || response.status === 403)
    return { kind: 'unknown', reason: `${where}: http ${response.status} (credential refused)` };
  if (response.status >= 300)
    return { kind: 'status', status: response.status, message: text.slice(0, 200) };
  if (call.accept === 'text')
    return { kind: 'text', status: response.status, text: text.slice(-MAX_TEXT) };
  try {
    return { kind: 'ok', status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { kind: 'unknown', reason: `${where}: garbage (reply is not JSON)` };
  }
}

/** Разбор тела в значение; не та форма — `unknown('garbage …')`, не исключение. */
export function shaped<T>(
  where: string,
  parse: (body: unknown) => T | null,
  body: unknown,
): Fact<T> {
  let out: T | null;
  try {
    out = parse(body);
  } catch {
    out = null;
  }
  return out === null ? { unknown: `${where}: garbage (unexpected reply shape)` } : { value: out };
}

/** Чтение по id: 404 — «прочитал — нет»; прочее не-успешное — `unknown`. */
export function readById<T>(
  reply: ForgeReply,
  where: string,
  parse: (body: unknown) => T | null,
): Fact<T> {
  if (reply.kind === 'ok') return shaped(where, parse, reply.body);
  if (reply.kind === 'status' && reply.status === 404) return ABSENT;
  return { unknown: unknownReason(reply, where) };
}

/** Чтение списка: 404 тоже `unknown` — нет проекта ≠ пустой список. */
export function readList<T>(
  reply: ForgeReply,
  where: string,
  parse: (body: unknown) => T | null,
): Fact<T> {
  if (reply.kind === 'ok') return shaped(where, parse, reply.body);
  return { unknown: unknownReason(reply, where) };
}

/** Запись: любой не-успех — `unknown`; узнать, дошла ли она, — дело сверки outbox. */
export function written<T>(
  reply: ForgeReply,
  where: string,
  parse: (body: unknown) => T | null,
): ForgeWrite<T> {
  const fact = readList(reply, where, parse);
  return 'value' in fact
    ? { value: fact.value }
    : { unknown: 'unknown' in fact ? fact.unknown : where };
}

export function unknownReason(reply: ForgeReply, where: string): string {
  if (reply.kind === 'unknown') return reply.reason;
  if (reply.kind === 'status') return `${where}: http ${reply.status}`;
  return `${where}: unexpected reply`;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const asArray = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** Порядок событий: по времени, при равном — по числовому id форжа (порядок записи). */
export function byTime(a: { at: number; id: string }, b: { at: number; id: string }): number {
  const ai = Number(a.id);
  const bi = Number(b.id);
  return a.at - b.at || (Number.isNaN(ai) || Number.isNaN(bi) ? 0 : ai - bi);
}

export const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
};

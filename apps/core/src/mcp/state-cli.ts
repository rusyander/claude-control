import { CORE_VARS } from '../adapters/launcher/env.ts';
import { httpJson, type HttpJsonCall, type HttpJsonOutcome } from '../platform/http-json.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import type { Fact } from '@agentdeck/contracts/core/facts';

/**
 * `agentdeck state [--field <dot.path>]` (03:81-82, G8) — для авторов хуков человека: документ
 * состояния сессии. Правда — ядро (`GET /v1/session/state` по токену сессии из окружения CLI);
 * ядро недоступно или не ответило документом — снимок запуска (`AGENTDECK_STATE`, `source:
 * 'snapshot'`), причина — в stderr, код 0: хук получает данные на момент старта, а не отказ.
 * Код 1 — нет ни ядра, ни снимка; код 2 — неверный вызов. Токен сессии не печатается никогда:
 * вывод проходит замену токена, даже если его вернул кто-то на порту ядра.
 */

export const STATE_COMMAND = 'state';
const FIELD_FLAG = '--field';
/** Хук ждёт ответа синхронно: ядро на loopback либо отвечает быстро, либо его нет. */
const CORE_TIMEOUT_MS = 3000;
const REDACTED = '<session-token>';

export interface StateCliDeps {
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  http(call: HttpJsonCall): Promise<HttpJsonOutcome>;
  readFile(path: string): Fact<Buffer>;
}

const DEFAULT_DEPS: StateCliDeps = {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  http: httpJson,
  readFile: (path) => readBytesSync(path),
};

const USAGE = `usage: agentdeck ${STATE_COMMAND} [${FIELD_FLAG} <dot.path>]\n`;

function parseArgs(argv: readonly string[]): { field: string | null } | { error: string } {
  const [command, ...rest] = argv;
  if (command !== STATE_COMMAND)
    return { error: `unknown command ${command === undefined ? '(none)' : `«${command}»`}` };
  if (rest.length === 0) return { field: null };
  if (rest.length === 2 && rest[0] === FIELD_FLAG && rest[1]) return { field: rest[1] };
  return { error: `unexpected arguments: ${rest.join(' ')}` };
}

/** Значение по пути `a.b.0.c`; `undefined` — пути нет (не «пусто»). */
function fieldOf(doc: unknown, path: string): unknown {
  let at: unknown = doc;
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

const isDoc = (body: unknown): body is Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body) && 'v' in body;

async function fromCore(
  deps: StateCliDeps,
): Promise<{ doc: Record<string, unknown> } | { why: string }> {
  const url = deps.env[CORE_VARS.coreUrl];
  const token = deps.env[CORE_VARS.access];
  if (!url || !token) return { why: `${CORE_VARS.coreUrl}/${CORE_VARS.access} not set` };
  const got = await deps.http({
    url: `${url}/v1/session/state`,
    method: 'GET',
    bearer: token,
    timeoutMs: CORE_TIMEOUT_MS,
  });
  if (got.kind === 'unreachable') return { why: `core unreachable: ${got.reason}` };
  if (got.status === 200 && isDoc(got.body)) return { doc: got.body };
  const body = got.body as { code?: unknown } | null;
  return { why: `core answered ${got.status} ${String(body?.code ?? '')}`.trim() };
}

function fromSnapshot(deps: StateCliDeps): { doc: Record<string, unknown> } | { why: string } {
  const path = deps.env[CORE_VARS.state];
  if (!path) return { why: `${CORE_VARS.state} not set` };
  const got = deps.readFile(path);
  if ('absent' in got) return { why: `snapshot ${path} absent` };
  if ('unknown' in got) return { why: `snapshot unreadable: ${got.unknown}` };
  try {
    const doc = JSON.parse(got.value.toString('utf8')) as unknown;
    // Снимок — всегда снимок, что бы ни лежало в поле файла.
    if (isDoc(doc)) return { doc: { ...doc, source: 'snapshot' } };
    return { why: 'snapshot is not a state document' };
  } catch (error) {
    return { why: `snapshot is not JSON: ${(error as Error).message}` };
  }
}

export async function runStateCli(
  argv: readonly string[],
  deps: StateCliDeps = DEFAULT_DEPS,
): Promise<number> {
  const args = parseArgs(argv);
  if ('error' in args) {
    deps.err(`agentdeck: ${args.error}\n${USAGE}`);
    return 2;
  }
  const token = deps.env[CORE_VARS.access];
  const redact = (text: string): string => (token ? text.split(token).join(REDACTED) : text);
  let got = await fromCore(deps);
  if ('why' in got) {
    const core = got.why;
    got = fromSnapshot(deps);
    if ('why' in got) {
      deps.err(redact(`agentdeck state: ${core}; ${got.why}\n`));
      return 1;
    }
    deps.err(redact(`agentdeck state: ${core}; showing the launch snapshot\n`));
  }
  if (args.field === null) {
    deps.out(redact(`${JSON.stringify(got.doc, null, 2)}\n`));
    return 0;
  }
  const value = fieldOf(got.doc, args.field);
  if (value === undefined) {
    deps.err(`agentdeck state: no field ${args.field}\n`);
    return 1;
  }
  deps.out(redact(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`));
  return 0;
}

import { bridgeEnv } from './bridges.ts';
import { coreCheck, coreSince, newestCore } from './core-discovery.ts';
import { createCoreClient, type CoreClient } from './core-client.ts';

/**
 * Хук ядра PreToolUse (03 §Launcher, 06 §Session permissions, R:S2-01): процесс, который CLI
 * зовёт перед КАЖДЫМ вызовом инструмента (`run.ts hook`). Сам ничего не решает: несёт вызов в
 * ядро (`POST /v1/session/hook` с токеном своей сессии), решает `policy/permit` там. Ответ CLI —
 * кодом выхода, как его понимают Claude Code и Qwen Code: 0 без вывода — «дальше обычной
 * дорогой права», 2 с причиной в stderr — вызов запрещён, причину видит модель.
 *
 * Fail-closed (P41): нет окружения сессии, вызов не читается, ядро не ответило или ответило не
 * той формой — отказ, никогда не «разрешено». Ядро перезапускается — хук ждёт новое по
 * `procs.json`, как мосты MCP, но в пределах срока хука у CLI (60 с у Claude по умолчанию).
 */

/** Сколько хук ждёт ядро: меньше срока хука у CLI — иначе CLI снимет хук раньше ответа. */
export const HOOK_WAIT_MS = 50_000;
/** Сколько повторять 503 (сессия ещё не прикреплена новым ядром). */
export const HOOK_UNAVAILABLE_MS = 45_000;
/** Срок одного запроса к ядру. */
export const HOOK_REQUEST_MS = 40_000;
/**
 * Сузить ожидание (проверки «ядро недоступно»). Только вниз: длиннее `HOOK_WAIT_MS` не бывает,
 * а короче — лишь раньше отказ, разрешения переменная не даёт.
 */
export const HOOK_WAIT_VAR = 'AGENTDECK_HOOK_WAIT_MS';

export interface HookIo {
  env: NodeJS.ProcessEnv;
  stdin: string;
  stderr: (line: string) => void;
  /** Клиент ядра (подмена в тестах); по умолчанию — тот же, что у мостов MCP. */
  client?: (opts: { url: string; token: string; procs?: string; waitMs: number }) => CoreClient;
}

export interface HookCall {
  tool: string;
  input: Record<string, unknown>;
  /**
   * id вызова в потоке, если CLI его дал (Qwen Code — `tool_call_id`, Claude Code — `tool_use_id`):
   * строка решения хука несёт его, и
   * наблюдатель (этап 8) не считает один и тот же отказ дважды. Нет — поля нет.
   */
  toolUseId?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Вызов из stdin хука: `tool_name` + `tool_input` (Claude Code, Qwen Code), `tool_use_id` если есть. */
export function readHookCall(stdin: string): HookCall | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdin);
  } catch {
    return undefined;
  }
  if (!isObject(doc) || typeof doc.tool_name !== 'string' || doc.tool_name === '') return undefined;
  const input = doc.tool_input ?? {};
  if (!isObject(input)) return undefined;
  // Qwen Code: `tool_use_id` — его внутренний id (`toolu_<ms>_…`), id вызова в потоке —
  // `tool_call_id` (проба этапа 8). Claude Code даёт только `tool_use_id` — он и есть id потока.
  const callId = doc.tool_call_id;
  const id = typeof callId === 'string' && callId !== '' ? callId : doc.tool_use_id;
  return {
    tool: doc.tool_name,
    input,
    ...(typeof id === 'string' && id !== '' ? { toolUseId: id } : {}),
  };
}

function waitOf(env: NodeJS.ProcessEnv): number {
  const asked = Number(env[HOOK_WAIT_VAR]);
  return Number.isFinite(asked) && asked >= 0 ? Math.min(asked, HOOK_WAIT_MS) : HOOK_WAIT_MS;
}

function defaultClient(opts: {
  url: string;
  token: string;
  procs?: string;
  waitMs: number;
}): CoreClient {
  const check = coreCheck();
  const procs = opts.procs;
  return createCoreClient({
    url: opts.url,
    token: opts.token,
    retryForMs: opts.waitMs,
    unavailableForMs: Math.min(HOOK_UNAVAILABLE_MS, opts.waitMs),
    stepMs: 250,
    timeoutMs: HOOK_REQUEST_MS,
    ...(procs
      ? {
          rediscover: (current: string) => newestCore(procs, current, check),
          newCore: (since: number) => coreSince(procs, since, check),
        }
      : {}),
  });
}

/** Код выхода хука: 0 — разрешено, 2 — запрещено или не решено (причина уже в stderr). */
export async function runCoreHook(io: HookIo): Promise<number> {
  const deny = (reason: string): number => {
    io.stderr(`agentdeck: ${reason}\n`);
    return 2;
  };
  const env = bridgeEnv(io.env);
  if ('missing' in env) return deny(`core hook without session env (${env.missing.join(', ')})`);
  const call = readHookCall(io.stdin);
  if (!call) return deny('core hook could not read the tool call; denied');
  const client = (io.client ?? defaultClient)({
    url: env.url,
    token: env.token,
    waitMs: waitOf(io.env),
    ...(env.procs ? { procs: env.procs } : {}),
  });
  const got = await client.post('/v1/session/hook', call, { idempotent: true });
  if (got.kind !== 'reply') return deny(`core unreachable (${got.reason}); denied`);
  const body = got.body as { allow?: unknown; reason?: unknown; code?: unknown } | null;
  if (got.status !== 200) {
    return deny(`core refused the hook (${got.status} ${String(body?.code ?? '')}); denied`);
  }
  if (body?.allow === true) return 0;
  if (body?.allow === false) {
    return deny(`Denied by the platform: ${String(body.reason ?? 'no reason')}.`);
  }
  return deny('core answered the hook without a decision; denied');
}

/** Процесс хука: stdin целиком, затем решение. */
export async function runHookProcess(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return runCoreHook({
    env: process.env,
    stdin: Buffer.concat(chunks).toString('utf8'),
    stderr: (line) => void process.stderr.write(line),
  });
}

import { journalLines, type SelftestPair } from '../../__fixtures__/selftest.ts';

/**
 * Пары самопроверки предикатов целостности (P33): журнал, где сигнал выходит, и его
 * почти-двойник. Их же гоняют тесты предикатов (`integrity.test.ts`) и каталог.
 */

const RID = '01900000-0000-7000-8000-0000000000a1';
const STEP = '01900000-0000-7000-8000-0000000000c1';
const S1 = '01900000-0000-7000-8000-0000000000d1';
const ROUTE = 'claude-login';
export const WINDOW_TOKENS = 200_000;

const created = {
  kind: 'resource.created' as const,
  data: { rid: RID, kind: 'copy', owner: 'core', release: 'step-end', ref: '/w/copy' },
};

export const LEAKED_LEASE = journalLines([
  created,
  { kind: 'resource.leak', data: { rid: RID, reason: 'lease release refused: 503' } },
]);
/** Почти-двойник: тот же ресурс снят честно. */
export const RELEASED_LEASE = journalLines([
  created,
  { kind: 'resource.released', data: { rid: RID } },
  { kind: 'resource.verified', data: { rid: RID, fact: 'gone' } },
]);

const win = (verdict: string, resetAt: number | null = null) => ({
  kind: 'window.state' as const,
  sessionId: S1,
  data: { routeId: ROUTE, limitKind: 'window', verdict, resetAt },
});

export const WINDOW_REFUSAL = journalLines([win('warn'), win('refused', 1_700_000_600_000)]);
/**
 * Почти-двойник «окна»: тот же маршрут предупреждал и открылся снова — ни один переход не в
 * держащий вердикт… но переход в `warn` тоже сигнал (первая ступень). Двойник поэтому — строки,
 * где вердикт не меняется: тот же `open` со сдвигом срока сброса.
 */
export const WINDOW_STEADY = journalLines([
  win('open', 1_700_000_100_000),
  win('open', 1_700_000_200_000),
]);

const started = (sessionId: string, resumeOf: string | null = null) => ({
  kind: 'session.started' as const,
  sessionId,
  stepId: STEP,
  data: {
    sessionId,
    stepId: STEP,
    adapter: 'claude',
    cliVersion: '1',
    route: { kind: 'cli-login', id: ROUTE },
    hops: [],
    credentialKind: 'none',
    modelAsked: null,
    modelServed: null,
    effort: null,
    hostPid: 1,
    hostStart: 'x',
    cliPid: null,
    cliStart: null,
    cwd: '/w',
    argv: [],
    resumeOf,
    cacheAgeMs: null,
  },
});

export const usage = (
  sessionId: string,
  context: number,
  extra: {
    subagent?: boolean;
    remainder?: boolean;
    contextWindow?: number;
    messageId?: string;
  } = {},
) => ({
  kind: 'turn.usage' as const,
  sessionId,
  data: {
    sessionId,
    messageId: extra.messageId ?? `m-${context}`,
    // Контекст = вход + чтение + запись кэша: делим его, чтобы сумма была проверкой формулы.
    input: Math.round(context * 0.1),
    cacheRead: context - Math.round(context * 0.1) - Math.round(context * 0.2),
    cacheWrite: Math.round(context * 0.2),
    cacheWrite1h: 0,
    output: 500,
    routeId: ROUTE,
    model: 'model-a',
    subagent: extra.subagent ?? false,
    parentSessionId: null,
    remainder: extra.remainder ?? false,
    ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}),
  },
});

/** Рост контекста главной сессии: 30 % → 50 % → 65 % окна. */
export const CONTEXT_RAMP = journalLines([
  started(S1),
  usage(S1, 60_000),
  usage(S1, 100_000),
  usage(S1, 130_000),
]);
/** Почти-двойник: тот же рост останавливается на 55 % окна (порог 60 %). */
export const CONTEXT_55 = journalLines([
  started(S1),
  usage(S1, 60_000),
  usage(S1, 100_000),
  usage(S1, 110_000),
]);

export { started as sessionStarted, S1, STEP, ROUTE, RID };

export const SELFTESTS: SelftestPair[] = [
  { signal: 'resource-leak', fires: LEAKED_LEASE, silent: RELEASED_LEASE },
  { signal: 'window', fires: WINDOW_REFUSAL, silent: WINDOW_STEADY },
  {
    signal: 'context-growth',
    fires: CONTEXT_RAMP,
    silent: CONTEXT_55,
    windowOf: () => WINDOW_TOKENS,
  },
];

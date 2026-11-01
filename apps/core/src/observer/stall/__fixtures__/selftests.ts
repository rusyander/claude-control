import { journalLines, type SelftestPair } from '../../__fixtures__/selftest.ts';

/**
 * Пара самопроверки предиката тишины (P33): строка `session.probe` затихшей сессии, перешедшей
 * порог, — сигнал `stall`; почти-двойник — та же сессия, затихшая и вернувшаяся к жизни без
 * пробы (порог не перейдён, проводка пробы не писала): тишина короче порога не сигнал.
 */

const STEP = '01900000-0000-7000-8000-0000000000c2';
const S1 = '01900000-0000-7000-8000-0000000000d2';

const move = (event: string, from: string, to: string) => ({
  kind: 'session.transition' as const,
  sessionId: S1,
  stepId: STEP,
  data: { sessionId: S1, event, from, to },
});

export const QUIET_PAST_THRESHOLD = journalLines([
  move('silent', 'live', 'quiet'),
  {
    kind: 'session.probe',
    sessionId: S1,
    stepId: STEP,
    data: {
      sessionId: S1,
      verdict: 'alive',
      cpuDeltaMs: 0,
      quietMs: 600_000,
      thresholdMs: 600_000,
      toolClass: 'model',
      reason: 'host pid 1; threshold: no learned p95',
    },
  },
]);

/** Почти-двойник: тишина без пробы — вернулась к жизни раньше порога. */
export const QUIET_BELOW_THRESHOLD = journalLines([
  move('silent', 'live', 'quiet'),
  move('output', 'quiet', 'live'),
]);

export const SELFTESTS: SelftestPair[] = [
  { signal: 'stall', fires: QUIET_PAST_THRESHOLD, silent: QUIET_BELOW_THRESHOLD },
];

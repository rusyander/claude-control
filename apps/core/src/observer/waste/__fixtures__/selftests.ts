import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import { toolEventData } from '../../../journal/__fixtures__/journal-harness.ts';
import { journalLines, type SelftestPair } from '../../__fixtures__/selftest.ts';
import { WASTE_BIG_READ } from '../big-read.ts';
import { WASTE_FAIL_REPEAT } from '../fail-repeat.ts';
import { WASTE_POLL } from '../poll.ts';
import { WASTE_REFUSAL_REPEAT } from '../refusal-repeat.ts';
import { WASTE_REREAD } from '../reread.ts';

/**
 * Пары самопроверки предикатов расточительства (P33): журнал, где сигнал выходит, и его
 * почти-двойник, где молчит. Их гоняет `waste.test.ts` (и каталог, когда найдёт файлы сам).
 */

export const STEP = '01900000-0000-7000-8000-0000000000c2';
export const S1 = '01900000-0000-7000-8000-0000000000d2';
export const CWD = '/copy';
export const FP_A = `sha256:${'a'.repeat(64)}`;
export const FP_B = `sha256:${'b'.repeat(64)}`;
export const DIGEST_X = 'c'.repeat(64);
export const DIGEST_Y = 'd'.repeat(64);

type ToolEvent = JournalDataV1['tool.event'];
type Row = Parameters<typeof journalLines>[0][number];

let n = 0;
/** Строка `tool.event` шага и сессии пары: id вызова свой у каждой. */
export function ev(over: Partial<ToolEvent>): Row {
  n += 1;
  return {
    kind: 'tool.event',
    stepId: STEP,
    sessionId: over.sessionId ?? S1,
    data: toolEventData(S1, over.target ?? '/copy/a.ts', n, {
      toolUseId: `toolu_${n}`,
      cwd: CWD,
      ...over,
    }),
  };
}

export const read = (target: string, fileFp: string, over: Partial<ToolEvent> = {}): Row =>
  ev({ target, fileFp, sizeBytes: 100, ...over });

export const edit = (target: string): Row =>
  ev({ tool: 'Edit', effectClass: 'edit', target, fileFp: null });

export const fail = (argvDigest: string, over: Partial<ToolEvent> = {}): Row =>
  ev({
    tool: 'Bash',
    effectClass: 'exec',
    target: 'node',
    argvDigest,
    isError: true,
    exitCode: 3,
    display: 'node fail.js',
    ...over,
  });

export const wait = (over: Partial<ToolEvent> = {}): Row =>
  ev({ tool: 'Bash', effectClass: 'wait', target: 'sleep', display: 'sleep 30', ...over });

/** Отказ судьи права (`decision{class:'permit'}`), как его пишут обе дороги. */
export function refused(
  target: string,
  over: {
    toolUseId?: string | null;
    code?: string;
    humanPoint?: number | null;
    stepId?: string;
    tool?: string;
  } = {},
): Row {
  return {
    kind: 'decision',
    stepId: over.stepId ?? STEP,
    sessionId: S1,
    data: {
      decisionId: `01900000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`,
      class: 'permit',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: ['denied'],
      output: {
        allow: false,
        action: 'exec',
        target,
        tool: over.tool ?? 'Bash',
        code: over.code ?? 'deny-command',
        humanPoint: over.humanPoint ?? null,
        ...(over.toolUseId === null ? {} : { toolUseId: over.toolUseId ?? `toolu_r${n}` }),
      },
    },
  };
}

export const lines = (rows: readonly Row[]): JournalLine[] => journalLines(rows);

export const SELFTESTS: SelftestPair[] = [
  {
    signal: WASTE_REREAD,
    fires: lines([read('/copy/a.ts', FP_A), read('/copy/a.ts', FP_A)]),
    // Почти-двойник: между чтениями правка — новый отпечаток, новое чтение законно.
    silent: lines([read('/copy/a.ts', FP_A), edit('/copy/a.ts'), read('/copy/a.ts', FP_B)]),
  },
  {
    signal: WASTE_BIG_READ,
    fires: lines([read('/copy/README.md', FP_A, { sizeBytes: 64 * 1024 })]),
    // Почти-двойник: тот же большой файл, но окном.
    silent: lines([
      read('/copy/README.md', FP_A, { sizeBytes: 64 * 1024, range: { offset: 1, limit: 200 } }),
    ]),
  },
  {
    signal: WASTE_FAIL_REPEAT,
    fires: lines([fail(DIGEST_X), fail(DIGEST_X)]),
    // Почти-двойник: два РАЗНЫХ падения.
    silent: lines([fail(DIGEST_X), fail(DIGEST_Y)]),
  },
  {
    signal: WASTE_POLL,
    fires: lines([wait(), wait()]),
    // Почти-двойник: одно ожидание, затем работа.
    silent: lines([wait(), read('/copy/out.log', FP_A)]),
  },
  {
    signal: WASTE_REFUSAL_REPEAT,
    fires: lines([refused('git'), refused('git')]),
    // Почти-двойник: два разных отказа.
    silent: lines([refused('git'), refused('curl')]),
  },
];

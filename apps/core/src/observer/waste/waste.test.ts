import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { foldObserver, initObserverFold } from '../fold.ts';
import type { FiredVerdict, PredicateCtx } from '../observer.types.ts';
import { OBSERVER_PREDICATES } from '../registry.ts';
import {
  DIGEST_X,
  DIGEST_Y,
  FP_A,
  FP_B,
  S1,
  SELFTESTS,
  STEP,
  edit,
  ev,
  fail,
  lines,
  read,
  refused,
  wait,
} from './__fixtures__/selftests.ts';
import { BIG_READ_BYTES, WASTE_BIG_READ } from './big-read.ts';
import { WASTE_FAIL_REPEAT } from './fail-repeat.ts';
import { WASTE_POLL } from './poll.ts';
import { REFUSAL_SAME_MS, WASTE_REFUSAL_REPEAT } from './refusal-repeat.ts';
import { WASTE_REREAD, covers } from './reread.ts';

/**
 * Предикаты расточительства (этап 8, 06:134-137) через НАСТОЯЩУЮ свёртку наблюдателя со всем
 * реестром: у каждого сигнала пара «срабатывает / почти-двойник молчит» (P33) и границы, на
 * которых стоит его определение (окно, порог, сброс, ступень после подсказки, дедуп отказа).
 */

const CTX: PredicateCtx = { windowOf: () => null, now: () => 0 };

function run(journal: readonly JournalLine[]): FiredVerdict[] {
  let fold = initObserverFold();
  const out: FiredVerdict[] = [];
  for (const line of journal) {
    const step = foldObserver(fold, line, CTX, OBSERVER_PREDICATES);
    fold = step.state;
    out.push(...step.verdicts);
  }
  return out;
}

const of = (signal: string, journal: readonly JournalLine[]) =>
  run(journal).filter((v) => v.signal === signal);

/** Сдвинуть время строк (отказы без id сливаются в окне 2 с). */
const at = (journal: JournalLine[], ms: number[]): JournalLine[] =>
  journal.map((l, i) => ({ ...l, at: 1_700_000_000_000 + (ms[i] ?? 0) }));

describe('stage 8 waste predicates (observer fold)', () => {
  describe('selftest pairs', () => {
    for (const pair of SELFTESTS) {
      it(`${pair.signal} fires on its journal and stays silent on the near-miss twin`, () => {
        expect(of(pair.signal, pair.fires).length).toBeGreaterThan(0);
        expect(of(pair.signal, pair.silent)).toEqual([]);
      });
    }
  });

  describe('waste-reread', () => {
    it('fires once per path and fingerprint, on the second covered read, with step and session', () => {
      const got = of(
        WASTE_REREAD,
        lines([read('/copy/a.ts', FP_A), read('/copy/a.ts', FP_A), read('/copy/a.ts', FP_A)]),
      );
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ subject: '/copy/a.ts', stepId: STEP, sessionId: S1 });
      expect(got[0]?.inputs).toEqual([2]);
    });

    it('a window not covered by earlier windows is no reread; a whole read covers any window', () => {
      const w = (offset: number | null, limit: number | null) => ({ range: { offset, limit } });
      expect(
        of(
          WASTE_REREAD,
          lines([read('/copy/a.ts', FP_A, w(1, 100)), read('/copy/a.ts', FP_A, w(50, 100))]),
        ),
      ).toEqual([]);
      expect(
        of(WASTE_REREAD, lines([read('/copy/a.ts', FP_A), read('/copy/a.ts', FP_A, w(50, 10))])),
      ).toHaveLength(1);
      expect(covers({ offset: 1, limit: 100 }, { offset: 10, limit: 20 })).toBe(true);
      expect(covers({ offset: 10, limit: 20 }, null)).toBe(false);
      expect(covers({ offset: -30, limit: null }, { offset: -30, limit: null })).toBe(true);
      expect(covers({ offset: -30, limit: null }, { offset: -10, limit: null })).toBe(false);
      // Окно самого CLI (qwen без окна режет файл): равно только себе, «целиком» не считается.
      const cli = { offset: null, limit: null };
      expect(
        of(
          WASTE_REREAD,
          lines([
            read('/copy/a.ts', FP_A, { range: cli }),
            read('/copy/a.ts', FP_A, { range: cli }),
          ]),
        ),
      ).toHaveLength(1);
      expect(covers(cli, { offset: 300, limit: 10 })).toBe(false);
      expect(covers({ offset: 1, limit: 100 }, cli)).toBe(false);
      expect(covers(null, cli)).toBe(false);
      expect(covers(cli, null)).toBe(false);
    });

    it('a subagent context and a compacted main context are fresh; an unknown fingerprint is never judged', () => {
      const sub = { parentToolUseId: 'toolu_task' };
      expect(
        of(WASTE_REREAD, lines([read('/copy/a.ts', FP_A), read('/copy/a.ts', FP_A, sub)])),
      ).toEqual([]);
      const usage = (tokens: number) => ({
        kind: 'turn.usage' as const,
        sessionId: S1,
        data: {
          sessionId: S1,
          messageId: `m${tokens}`,
          input: tokens,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          output: 1,
          routeId: 'r',
          model: 'm',
          subagent: false,
          parentSessionId: null,
          remainder: false,
        },
      });
      expect(
        of(
          WASTE_REREAD,
          lines([
            usage(100_000),
            read('/copy/a.ts', FP_A),
            usage(40_000),
            read('/copy/a.ts', FP_A),
          ]),
        ),
      ).toEqual([]);
      // Падение ровно вдвое — не сжатие.
      expect(
        of(
          WASTE_REREAD,
          lines([
            usage(100_000),
            read('/copy/a.ts', FP_A),
            usage(50_000),
            read('/copy/a.ts', FP_A),
          ]),
        ),
      ).toHaveLength(1);
      expect(
        of(
          WASTE_REREAD,
          lines([
            read('/copy/a.ts', FP_A, { fileFp: null }),
            read('/copy/a.ts', FP_A, { fileFp: null }),
          ]),
        ),
      ).toEqual([]);
    });
  });

  describe('waste-big-read', () => {
    it('fires above 30 KiB read whole only; a window, an error or an unknown size is silent', () => {
      const big = (sizeBytes: number | null, over = {}) =>
        of(WASTE_BIG_READ, lines([read('/copy/b.md', FP_B, { sizeBytes, ...over })]));
      // Порог спеки F4 — литералом: константа, которую сверяет тест, сама могла уплыть.
      expect(BIG_READ_BYTES).toBe(30_720);
      expect(big(30_720)).toEqual([]);
      expect(big(30_721)).toHaveLength(1);
      expect(big(BIG_READ_BYTES + 1)[0]?.subject).toBe('/copy/b.md');
      expect(big(64 * 1024, { range: { offset: 1, limit: 50 } })).toEqual([]);
      // Qwen без окна режет файл до ~25 KB (проба M) — окно CLI, не большое чтение.
      expect(big(64 * 1024, { range: { offset: null, limit: null } })).toEqual([]);
      expect(big(64 * 1024, { isError: true })).toEqual([]);
      expect(big(null)).toEqual([]);
    });
  });

  describe('waste-fail-repeat', () => {
    it('second same failure is a hint, third escalates to stop, fourth adds nothing', () => {
      const got = of(
        WASTE_FAIL_REPEAT,
        lines([fail(DIGEST_X), fail(DIGEST_X), fail(DIGEST_X), fail(DIGEST_X)]),
      );
      expect(got.map((v) => v.escalated ?? false)).toEqual([false, true]);
      expect(got[0]).toMatchObject({ subject: 'node fail.js', stepId: STEP });
    });

    it('an edit in the session or a success in the same directory resets the count', () => {
      expect(
        of(WASTE_FAIL_REPEAT, lines([fail(DIGEST_X), edit('/copy/a.ts'), fail(DIGEST_X)])),
      ).toEqual([]);
      const ok = ev({ tool: 'Bash', effectClass: 'exec', target: 'ls', argvDigest: DIGEST_Y });
      expect(of(WASTE_FAIL_REPEAT, lines([fail(DIGEST_X), ok, fail(DIGEST_X)]))).toEqual([]);
      // Успех в ДРУГОМ каталоге счёт не сбрасывает.
      const elsewhere = ev({
        tool: 'Bash',
        effectClass: 'exec',
        target: 'ls',
        argvDigest: DIGEST_Y,
        cwd: '/other',
      });
      expect(
        of(WASTE_FAIL_REPEAT, lines([fail(DIGEST_X), elsewhere, fail(DIGEST_X)])),
      ).toHaveLength(1);
    });

    it('another directory, another exit code or no argv digest is another command', () => {
      expect(
        of(WASTE_FAIL_REPEAT, lines([fail(DIGEST_X), fail(DIGEST_X, { cwd: '/other' })])),
      ).toEqual([]);
      expect(
        of(WASTE_FAIL_REPEAT, lines([fail(DIGEST_X), fail(DIGEST_X, { exitCode: 1 })])),
      ).toEqual([]);
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([fail(DIGEST_X, { argvDigest: null }), fail(DIGEST_X, { argvDigest: null })]),
        ),
      ).toEqual([]);
    });

    it('with no exit code the error digest decides; a call refused by the permit judge is no failure', () => {
      const noCode = (errorDigest: string | null) =>
        fail(DIGEST_X, { exitCode: null, errorDigest });
      expect(of(WASTE_FAIL_REPEAT, lines([noCode('e1'), noCode('e1')]))).toHaveLength(1);
      expect(of(WASTE_FAIL_REPEAT, lines([noCode('e1'), noCode('e2')]))).toEqual([]);
      expect(of(WASTE_FAIL_REPEAT, lines([noCode(null), noCode(null)]))).toEqual([]);
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('node', { toolUseId: 'toolu_d1' }),
            fail(DIGEST_X, { toolUseId: 'toolu_d1' }),
            refused('node', { toolUseId: 'toolu_d2' }),
            fail(DIGEST_X, { toolUseId: 'toolu_d2' }),
          ]),
        ),
      ).toEqual([]);
    });

    it('a refusal with no tool-use id, or an id the stream does not know, swallows the next error of the same tool in the session only', () => {
      // Дорога сервера права id вызова не пишет: отказ, затем его результат-ошибка.
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('node', { toolUseId: null }),
            fail(DIGEST_X),
            refused('node', { toolUseId: null }),
            fail(DIGEST_X),
          ]),
        ),
      ).toEqual([]);
      // Отказ другого инструмента чужую ошибку не глотает; отказ глотает ровно одну.
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('a.ts', { toolUseId: null, tool: 'Read' }),
            fail(DIGEST_X),
            fail(DIGEST_X),
          ]),
        ),
      ).toHaveLength(1);
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('node', { toolUseId: null }),
            fail(DIGEST_X),
            fail(DIGEST_X),
            fail(DIGEST_X),
          ]),
        ),
      ).toHaveLength(1);
      // Хук qwen пишет свой id (`toolu_…`), поток — `call_…` (проба M): отказ всё равно свой.
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('git', { toolUseId: 'toolu_internal_1' }),
            fail(DIGEST_X, { toolUseId: 'call_1' }),
            refused('git', { toolUseId: 'toolu_internal_2' }),
            fail(DIGEST_X, { toolUseId: 'call_2' }),
          ]),
        ),
      ).toEqual([]);
      // Дорога без имени инструмента: решает id вызова.
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('node', { toolUseId: 'toolu_d3', tool: '' }),
            fail(DIGEST_X, { toolUseId: 'toolu_d3' }),
            refused('node', { toolUseId: 'toolu_d4', tool: '' }),
            fail(DIGEST_X, { toolUseId: 'toolu_d4' }),
          ]),
        ),
      ).toEqual([]);
      // Отказ, совпавший по id, ждущий ключ инструмента снимает: следующие падения — падения.
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([
            refused('node', { toolUseId: 'toolu_d1' }),
            fail(DIGEST_X, { toolUseId: 'toolu_d1' }),
            fail(DIGEST_X),
            fail(DIGEST_X),
          ]),
        ),
      ).toHaveLength(1);
    });

    it('a standalone sleep the CLI blocks with one error each time is a poll, never a failing command', () => {
      // Проба M: «Blocked: standalone sleep 25» — is_error без кода, тот же текст каждый раз.
      const blocked = () =>
        wait({ argvDigest: DIGEST_X, isError: true, exitCode: null, errorDigest: 'blocked' });
      const journal = lines([blocked(), blocked(), blocked()]);
      expect(of(WASTE_FAIL_REPEAT, journal)).toEqual([]);
      expect(of(WASTE_POLL, journal)).toHaveLength(1);
      // Удачный сон ничего не поменял — серия падений команды им не сбрасывается.
      expect(
        of(
          WASTE_FAIL_REPEAT,
          lines([fail(DIGEST_X), wait({ argvDigest: DIGEST_Y, isError: false }), fail(DIGEST_X)]),
        ),
      ).toHaveLength(1);
    });
  });

  describe('waste-poll', () => {
    it('second wait in a row is a hint, the fourth escalates to stop', () => {
      const got = of(WASTE_POLL, lines([wait(), wait(), wait(), wait()]));
      expect(got.map((v) => v.escalated ?? false)).toEqual([false, true]);
      expect(got[1]?.inputs).toEqual([4]);
    });

    it('the first wait after the hint reached the model stops at once', () => {
      const delivered = {
        kind: 'message.delivered' as const,
        stepId: STEP,
        sessionId: S1,
        data: {
          stepId: STEP,
          sessionId: S1,
          ref: { kind: 'hint' as const, id: '01900000-0000-7000-8000-0000000000e1' },
        },
      };
      const got = of(WASTE_POLL, lines([wait(), wait(), delivered, wait()]));
      expect(got.map((v) => [v.escalated ?? false, v.inputs])).toEqual([
        [false, [2]],
        [true, [4]],
      ]);
    });

    it('any other call in the session or a turn the CLI started itself breaks the run', () => {
      expect(of(WASTE_POLL, lines([wait(), edit('/copy/a.ts'), wait()]))).toEqual([]);
      const wake = {
        kind: 'turn.cli-initiated' as const,
        sessionId: S1,
        data: { sessionId: S1, cause: 'background-wake' as const },
      };
      expect(of(WASTE_POLL, lines([wait(), wake, wait()]))).toEqual([]);
    });
  });

  describe('waste-refusal-repeat', () => {
    it('the second refusal of the same step, action, target and code stops; a human point is never counted', () => {
      const got = of(WASTE_REFUSAL_REPEAT, lines([refused('git'), refused('git')]));
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ subject: 'git', stepId: STEP });
      expect(
        of(
          WASTE_REFUSAL_REPEAT,
          lines([refused('git', { humanPoint: 5 }), refused('git', { humanPoint: 5 })]),
        ),
      ).toEqual([]);
      expect(
        of(
          WASTE_REFUSAL_REPEAT,
          lines([
            refused('git'),
            refused('git', { stepId: '01900000-0000-7000-8000-0000000000c9' }),
          ]),
        ),
      ).toEqual([]);
      expect(
        of(WASTE_REFUSAL_REPEAT, lines([refused('git'), refused('git', { code: 'other' })])),
      ).toEqual([]);
    });

    it('one call refused on two roads counts once: by tool-use id, or within 2 s when an id is missing', () => {
      expect(
        of(
          WASTE_REFUSAL_REPEAT,
          lines([
            refused('git', { toolUseId: 'toolu_x' }),
            refused('git', { toolUseId: 'toolu_x' }),
          ]),
        ),
      ).toEqual([]);
      const anon = lines([
        refused('git', { toolUseId: 'toolu_y' }),
        refused('git', { toolUseId: null }),
      ]);
      expect(of(WASTE_REFUSAL_REPEAT, at(anon, [0, REFUSAL_SAME_MS]))).toEqual([]);
      expect(of(WASTE_REFUSAL_REPEAT, at(anon, [0, REFUSAL_SAME_MS + 1]))).toHaveLength(1);
    });

    it('W P-c a refusal of the CLI itself (tool.event denied) counts: twice is a repeat; with the judge refusal of the same call (human point or not) it counts once; the denied row is no call for the other waste predicates', () => {
      const denied = (toolUseId: string) =>
        read('/copy/secret.txt', FP_A, { toolUseId, denied: true, isError: true });
      const twice = of(WASTE_REFUSAL_REPEAT, lines([denied('toolu_a'), denied('toolu_b')]));
      expect(twice).toHaveLength(1);
      expect(twice[0]).toMatchObject({ subject: '/copy/secret.txt', stepId: STEP });
      expect(of(WASTE_REFUSAL_REPEAT, lines([denied('toolu_a'), denied('toolu_a')]))).toEqual([]);
      // Судья ядра отказал тому же вызову (с пунктом человека и без) — отказ CLI тот же.
      for (const humanPoint of [5, null])
        expect(
          of(
            WASTE_REFUSAL_REPEAT,
            lines([
              refused('/copy/secret.txt', { toolUseId: 'toolu_a', humanPoint }),
              denied('toolu_a'),
              // Второй отказ CLI — первый свой: счёт 1, не повтор.
              denied('toolu_b'),
            ]),
          ),
          String(humanPoint),
        ).toEqual([]);
      // Строка отказа — не вызов: два отказа одного чтения не перечитывание и не повтор падения.
      expect(run(lines([denied('toolu_a'), denied('toolu_b')])).map((v) => v.signal)).toEqual([
        WASTE_REFUSAL_REPEAT,
      ]);
      // То же для команды, ожидания и большого чтения без диапазона: отказ CLI не падение, не
      // опрос и не чтение — у каждой пары только повтор отказа.
      const no = { denied: true, isError: true } as const;
      for (const pair of [
        [
          fail(DIGEST_X, { ...no, toolUseId: 'toolu_x1' }),
          fail(DIGEST_X, { ...no, toolUseId: 'toolu_x2' }),
        ],
        [wait({ ...no, toolUseId: 'toolu_w1' }), wait({ ...no, toolUseId: 'toolu_w2' })],
        [
          read('/copy/big.log', FP_B, {
            ...no,
            toolUseId: 'toolu_r1',
            sizeBytes: BIG_READ_BYTES + 1,
          }),
          read('/copy/big.log', FP_B, {
            ...no,
            toolUseId: 'toolu_r2',
            sizeBytes: BIG_READ_BYTES + 1,
          }),
        ],
      ])
        expect(run(lines(pair)).map((v) => v.signal)).toEqual([WASTE_REFUSAL_REPEAT]);
    });
  });

  it('every waste verdict names step and session, and its key starts with its catalog id', () => {
    for (const pair of SELFTESTS)
      for (const v of of(pair.signal, pair.fires)) {
        expect(v).toMatchObject({ stepId: STEP, sessionId: S1 });
        expect(v.key.startsWith(`${pair.signal}:`)).toBe(true);
      }
  });
});

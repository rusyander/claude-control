import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { journalLines } from '../__fixtures__/selftest.ts';
import { signalDef } from '../catalog.ts';
import { foldObserver, initObserverFold } from '../fold.ts';
import { judgeSignal } from '../judge.ts';
import type { FiredVerdict } from '../observer.types.ts';
import {
  GHOST_SPEND,
  LATE_SPAWN,
  S1,
  sessionEnded,
  sessionStarted,
  STEP,
  subagentUsage,
  usage,
} from './__fixtures__/selftests.ts';
import { SPEND_MISATTRIBUTED_SIGNAL } from './spend-misattributed.ts';

/**
 * Чужой расход (этап 11, P149) через свёртку наблюдателя со всеми предикатами реестра: строка
 * расхода назвала вызов субагента, которого сессия не запускала, — к родителю не прибавлена, а
 * названа сигналом на конце сессии; поздний `agent.spawned` своего вызова — не чужой расход.
 */

function fold(lines: readonly JournalLine[]): FiredVerdict[] {
  let state = initObserverFold();
  const out: FiredVerdict[] = [];
  for (const line of lines) {
    const step = foldObserver(state, line, { windowOf: () => null, now: () => 0 });
    expect(step.errors).toEqual([]);
    state = step.state;
    out.push(...step.verdicts.filter((v) => v.signal === SPEND_MISATTRIBUTED_SIGNAL));
  }
  return out;
}

describe('stage 11 spend-misattributed predicate (P149)', () => {
  it('usage naming a subagent call the session never spawned fires at session end, once per session and call', () => {
    const got = fold(GHOST_SPEND);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      subject: 'toolu_ghost',
      key: `${SPEND_MISATTRIBUTED_SIGNAL}:${S1}:toolu_ghost`,
      sessionId: S1,
      stepId: STEP,
      inputs: [2, 3],
    });
    expect(got[0]?.detail).toContain('2 usage rows');
    const def = signalDef(SPEND_MISATTRIBUTED_SIGNAL);
    const decision = judgeSignal(got[0] as FiredVerdict, def as NonNullable<typeof def>);
    expect(decision).toMatchObject({ fired: true, severity: 'warn', action: 'show' });
    // Тот же журнал, кончившийся задачей, а не сессией, — тоже один сигнал.
    const byTaskEnd = journalLines([
      sessionStarted(S1),
      subagentUsage('toolu_ghost', 'm-g1'),
      { kind: 'task.ended', data: { outcome: 'done' } },
    ]);
    expect(fold(byTaskEnd)).toHaveLength(1);
  });

  it('near-miss: usage that came before its own agent.spawned is the subagent spend, silent', () => {
    expect(fold(LATE_SPAWN)).toEqual([]);
    // Главный контекст (`null`) и строка без поля (до этапа 11) — не его.
    const main = journalLines([
      sessionStarted(S1),
      { ...usage(S1, 1000), data: { ...usage(S1, 1000).data, parentToolUseId: null } },
      usage(S1, 2000, { subagent: true, messageId: 'm-old' }),
      sessionEnded,
    ]);
    expect(fold(main)).toEqual([]);
  });
});

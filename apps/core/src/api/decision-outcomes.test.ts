import { describe, expect, it } from 'vitest';
import {
  DECISION_OUTCOMES,
  decisionOutcome,
  type DecisionOutcome,
} from '@agentdeck/contracts/core/decision-view';
import { DECISION_CLASS_IDS } from '@agentdeck/contracts/core/decisions';
import type { JournalDataV1, SignalAction } from '@agentdeck/contracts/core/journal';
import type { ComposeDecision, CheckDecision } from '@agentdeck/contracts/core/records';
import type { CompatDecision } from '@agentdeck/contracts/core/routes';
import type { CopySetupVerdict } from '../conductor/copy/copy.types.ts';
import type { NextAction } from '../conductor/next/next.types.ts';
import type { ReconcileVerdict } from '../conductor/reconcile.ts';
import type { SplitCheckDecision } from '../conductor/split-check/split-check.types.ts';
import type { EndpointDecision } from '../routes/endpoint.ts';
import type { FitDecision } from '../routes/local/own/fit.ts';
import type { SlotWaitAction } from '../routes/local/own/slot-wait.ts';

/**
 * Исходы решений для панели (этап 9, F1) против типов выхода, которые пишет ядро: список исходов
 * класса обязан совпасть с видами его выхода — новый вид без исхода (или исход, которого ядро не
 * пишет) не собирается. Классы, чей выход — флаг, а не вид, судит чтение на образцах ниже.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function same<T extends true>(): T | undefined {
  return undefined;
}

same<Equal<NextAction['kind'], DecisionOutcome<'next'>>>();
same<Equal<CheckDecision['kind'], DecisionOutcome<'check'>>>();
same<Equal<ComposeDecision['kind'], DecisionOutcome<'compose'>>>();
same<Equal<ReconcileVerdict, DecisionOutcome<'reconcile'>>>();
same<Equal<SlotWaitAction, DecisionOutcome<'slot-wait'>>>();
same<Equal<CompatDecision['kind'], DecisionOutcome<'compat'>>>();
same<Equal<FitDecision['kind'], DecisionOutcome<'fit'>>>();
same<Equal<EndpointDecision['kind'], DecisionOutcome<'endpoint'>>>();
same<Equal<SplitCheckDecision['verdict'], DecisionOutcome<'split-check'>>>();
same<Equal<CopySetupVerdict, DecisionOutcome<'copy-setup'>>>();
same<Equal<JournalDataV1['window.state']['verdict'], DecisionOutcome<'window'>>>();
same<Equal<'quiet' | SignalAction, DecisionOutcome<'observer'>>>();

describe('decision outcomes for the panel (stage 9, F1)', () => {
  it('every registered decision class has a non-empty declared outcome list', () => {
    expect(Object.keys(DECISION_OUTCOMES).sort()).toEqual([...DECISION_CLASS_IDS].sort());
    for (const cls of DECISION_CLASS_IDS)
      expect(DECISION_OUTCOMES[cls].length, cls).toBeGreaterThan(0);
  });

  it('reads the outcome from the output shape the core writes, per class', () => {
    const rows: [string, unknown, string | null][] = [
      ['check', { kind: 'replay', recordId: 'r', header: 'h' }, 'replay'],
      ['next', { kind: 'finish-task' }, 'finish-task'],
      ['tier', { adapter: 'claude', model: 'm' }, 'picked'],
      ['tier', { refused: true, reason: 'x' }, 'refused'],
      ['human-point', { point: 3, blocking: true }, 'blocking'],
      ['human-point', { point: 3, blocking: false }, 'non-blocking'],
      ['human-point', { point: null, fork: { options: [] } }, 'fork'],
      ['human-point', { point: null, refused: true }, 'refused'],
      ['observer', { fired: false, action: 'show' }, 'quiet'],
      ['observer', { fired: true, action: 'stop-step' }, 'stop-step'],
      ['red-before', { checkId: 'c', unknown: 'registry unreadable' }, 'unknown'],
      ['red-before', { proven: true }, 'proven'],
      ['red-before', { proven: false }, 'unproven'],
      ['schedule', { grant: [] }, 'waiting'],
      ['schedule', { grant: ['a'] }, 'granted'],
      ['budget', { over: [] }, 'within'],
      ['cleanup', { release: ['x'] }, 'release'],
      ['precedence', { keys: [{ key: 'a', rejected: [] }] }, 'within-levels'],
      ['precedence', { keys: [{ key: 'a', rejected: [{ level: 3 }] }] }, 'widening-rejected'],
      [
        'layer-run',
        { asked: { hooks: 'on', skills: 'on' }, ran: { hooks: 'observe', skills: 'on' } },
        'lowered',
      ],
      [
        'layer-run',
        { asked: { hooks: 'on', skills: 'on' }, ran: { hooks: 'on', skills: 'on' } },
        'as-asked',
      ],
      ['set-route', { ok: false }, 'refused'],
      // Не та форма, исход вне списка или класс не из реестра — `null`, никогда выдуманный исход.
      ['check', { kind: 'teleport' }, null],
      ['check', 'run', null],
      ['next', null, null],
      ['no-such-class', { kind: 'run' }, null],
    ];
    expect(rows.map(([cls, output]) => decisionOutcome(cls, output))).toEqual(
      rows.map(([, , want]) => want),
    );
  });
});

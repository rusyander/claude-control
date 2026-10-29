import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { JOURNAL_DATA_V1 } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { initialState, reduce } from './reduce.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce.types.ts';

/**
 * Личность прогона проверки в свёртке (G24): `check.requested` заводит прогон с проверкой,
 * единицей и ключом, переходы машины её сохраняют, `check.recorded` прикрепляет запись.
 */

const TASK = newId();
const BOOT = newId();

function line(seq: number, kind: JournalKind, data: unknown): JournalLine {
  return {
    v: 1,
    seq,
    at: 1_000 + seq,
    mono: seq,
    bootId: BOOT,
    taskId: TASK,
    kind,
    actor: 'core',
    data,
  } as JournalLine;
}

const fold = (lines: JournalLine[]): TaskFoldState => lines.reduce(reduce, initialState(TASK));

function requested(runId: string) {
  return {
    checkRunId: runId,
    checkId: 'unit-tests',
    unit: 'apps/core',
    key: 'a'.repeat(64),
    grade: 'unit' as const,
    origin: 'core' as const,
    road: 'model-tool' as const,
    stepId: null,
  };
}

const move = (runId: string, event: string, from: string, to: string) => ({
  checkRunId: runId,
  event,
  from,
  to,
});

describe('journal fold: check run identity (G24)', () => {
  it('G24 check.requested seeds identity, transitions keep it, check.recorded attaches the record', () => {
    const run = newId();
    const data = requested(run);
    // Строки, что пишет requestCheck, проходят схему журнала — свёртка видит то же, что ляжет на диск.
    expect(JOURNAL_DATA_V1['check.requested'].safeParse(data).success).toBe(true);
    const state = fold([
      line(1, 'check.requested', data),
      line(2, 'check.transition', move(run, 'lease', 'queued', 'leased')),
      line(3, 'check.transition', move(run, 'start', 'leased', 'running')),
      line(4, 'check.recorded', { checkRunId: run, recordId: `${'a'.repeat(64)}.0` }),
      line(5, 'check.transition', move(run, 'record', 'running', 'recorded')),
    ]);
    expect(state.anomalies).toEqual([]);
    expect(state.checks[run]).toEqual({
      state: 'recorded',
      run: data,
      recordId: `${'a'.repeat(64)}.0`,
    });
    expect(state.reducer).toBe(REDUCER_VERSION);
  });

  it('G24 a crash mid-run leaves a running check whose identity says what to resume or abort', () => {
    const run = newId();
    const state = fold([
      line(1, 'check.requested', requested(run)),
      line(2, 'check.transition', move(run, 'lease', 'queued', 'leased')),
      line(3, 'check.transition', move(run, 'start', 'leased', 'running')),
    ]);
    expect(state.checks[run]?.state).toBe('running');
    expect(state.checks[run]?.run).toMatchObject({ checkId: 'unit-tests', unit: 'apps/core' });
    expect(state.checks[run]?.recordId).toBeUndefined();
  });

  it('G24 twice-requested, unknown recorded and a second different record are anomalies; state kept', () => {
    const run = newId();
    const state = fold([
      line(1, 'check.requested', requested(run)),
      line(2, 'check.requested', { ...requested(run), unit: 'other' }),
      line(3, 'check.recorded', { checkRunId: newId(), recordId: 'x.0' }),
      line(4, 'check.recorded', { checkRunId: run, recordId: 'k.0' }),
      line(5, 'check.recorded', { checkRunId: run, recordId: 'k.1' }),
    ]);
    expect(state.anomalies.map((a) => a.reason)).toEqual([
      `check ${run} created twice`,
      expect.stringMatching(/^check\.recorded: unknown check/),
      `check.recorded: ${run} already recorded k.0`,
    ]);
    expect(state.checks[run]).toMatchObject({ run: { unit: 'apps/core' }, recordId: 'k.0' });
  });

  it('G24 a legacy transition-only check still folds, without identity', () => {
    const run = newId();
    const state = fold([line(1, 'check.transition', move(run, 'lease', 'queued', 'leased'))]);
    expect(state.checks[run]).toEqual({ state: 'leased' });
  });
});

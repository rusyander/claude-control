import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOURNAL_DATA_BY_VERSION, JOURNAL_VERSION } from '@agentdeck/contracts/core/journal';
import { tempDir } from './__fixtures__/journal-harness.ts';
import { readTaskView } from './read-view.ts';
import { readJournalLines } from './read-lines.ts';
import { JournalCorruptError, TASK_FILES } from './journal.types.ts';
import { UPCASTERS, upcastToCurrent } from './upcast.ts';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
/** Цепочка замороженной фикстуры v1: изменилась — значит фикстуру перегенерировали, а не сохранили. */
// Перегенерирована 28.10: `session.started` получил `argv` (решение координатора, W2-B).
// Перегенерирована 29.10: V1 дополнен этапом 4 на месте (G1) — `task.created.profilePins/origin/
// launchPolicy/ciWait`, строки `requirement.extracted`, `unit.created`, `scenario.overlay`, `step.started`.
const V1_HASH = '67b084199455f12045534f3f74637999a235ca2d87a86dbd8aab58a38d5a62ce';

function stage(fixture: string, mutate?: (lines: string[]) => string[]) {
  const text = readFileSync(join(FIXTURES, fixture), 'utf8');
  const taskId = (JSON.parse(text.split('\n')[0] ?? '{}') as { taskId: string }).taskId;
  const dir = tempDir();
  if (mutate) {
    const lines = mutate(text.trimEnd().split('\n'));
    writeFileSync(join(dir, TASK_FILES.journal), `${lines.join('\n')}\n`);
  } else copyFileSync(join(FIXTURES, fixture), join(dir, TASK_FILES.journal));
  return { dir, taskId };
}

describe('journal versions', () => {
  it('P45 every stored journal version has a frozen fixture and an upcaster chain to the current one', () => {
    const versions = Object.keys(JOURNAL_DATA_BY_VERSION).map(Number);
    expect(versions).toContain(JOURNAL_VERSION);
    for (const v of versions) {
      expect({ v, fixture: existsSync(join(FIXTURES, `v${v}.jsonl`)) }).toEqual({
        v,
        fixture: true,
      });
      if (v < JOURNAL_VERSION)
        expect({ v, upcaster: typeof UPCASTERS[v] }).toEqual({ v, upcaster: 'function' });
    }
  });

  it('P45 the frozen v1 journal still folds to the same state, with no anomalies', () => {
    const { dir, taskId } = stage('v1.jsonl');
    const read = readJournalLines(dir, taskId);
    expect(read.lastHash).toBe(V1_HASH);
    const { state } = readTaskView(dir, taskId);
    expect(state.anomalies).toEqual([]);
    expect(state.task).toBe('cancelled');
    expect(state.ended).toBe('cancelled');
    expect(state.created?.title).toBe('задача фикстуры v1');
    expect(Object.values(state.sessions).map((s) => s.state)).toEqual(['ended']);
    expect(Object.values(state.actions).map((a) => a.status)).toEqual(['done']);
    expect(Object.values(state.resources).map((r) => r.status)).toEqual(['released']);
    expect(Object.values(state.commands).map((c) => c.status)).toEqual(['applied']);
    expect(Object.values(state.units).map((u) => u.branch)).toEqual(['agentdeck/fixture']);
    expect(Object.values(state.steps).map((s) => s.stepKind)).toEqual(['work']);
    // В работе строки 5–19 по 1 с; строка скачка несёт 59 с сна и не добавляет ничего (P56).
    expect(state.counters.clockJumps).toBe(1);
    expect(state.work.activeMs).toBe(14_000);
  });

  it('P45 strict schemas: an unknown envelope field or data field in a stored line → corrupt, not dropped', () => {
    const extraEnvelope = stage('v1.jsonl', (lines) =>
      lines.map((l, i) => (i === 3 ? l.replace('{"v":1,', '{"v":1,"extra":1,') : l)),
    );
    expect(() => readJournalLines(extraEnvelope.dir, extraEnvelope.taskId)).toThrow(
      JournalCorruptError,
    );
    const extraData = stage('v1.jsonl', (lines) =>
      lines.map((l, i) => (i === 3 ? l.replace('"data":{', '"data":{"extra":1,') : l)),
    );
    expect(() => readJournalLines(extraData.dir, extraData.taskId)).toThrow(
      /seq 4|extra|Unrecognized/i,
    );
    // `session.started` без argv (каким его писали до 28.10) — тоже порча, не молчаливое «argv нет».
    const noArgv = stage('v1.jsonl', (lines) =>
      lines.map((l) =>
        l.includes('"kind":"session.started"') ? l.replace(/"argv":\[[^\]]*\],/, '') : l,
      ),
    );
    expect(() => readJournalLines(noArgv.dir, noArgv.taskId)).toThrow(/argv|seq 10/i);
    const newer = stage('v1.jsonl', (lines) =>
      lines.map((l, i) => (i === 3 ? l.replace('{"v":1,', '{"v":99,') : l)),
    );
    expect(() => readJournalLines(newer.dir, newer.taskId)).toThrow(JournalCorruptError);
  });

  it('session.started.modelAsked null (CLI default model) reads and folds to a null modelAsked; the frozen string line still reads', () => {
    // Расширение схемы (`registryId.nullable()`, 30.10): старая строка с моделью не ломается, новая
    // без модели — не порча.
    const noModel = stage('v1.jsonl', (lines) =>
      lines.map((l) =>
        l.includes('"kind":"session.started"')
          ? l.replace('"modelAsked":"model-a"', '"modelAsked":null')
          : l,
      ),
    );
    const { state } = readTaskView(noModel.dir, noModel.taskId);
    expect(state.anomalies).toEqual([]);
    expect(Object.values(state.sessions).map((s) => s.modelAsked)).toEqual([null]);
    const frozen = stage('v1.jsonl');
    expect(
      Object.values(readTaskView(frozen.dir, frozen.taskId).state.sessions).map(
        (s) => s.modelAsked,
      ),
    ).toEqual(['model-a']);
    // Пустая строка вместо модели — по-прежнему порча: «нет модели» пишется только `null`.
    const empty = stage('v1.jsonl', (lines) =>
      lines.map((l) =>
        l.includes('"kind":"session.started"')
          ? l.replace('"modelAsked":"model-a"', '"modelAsked":""')
          : l,
      ),
    );
    expect(() => readJournalLines(empty.dir, empty.taskId)).toThrow(/modelAsked|seq 10/i);
  });

  it('upcaster chain lifts an old line step by step and refuses a gap', () => {
    const table = {
      1: (l: { v: number; kind: string; data: unknown }) => ({ ...l, v: 2, data: { up: l.data } }),
    };
    expect(upcastToCurrent({ v: 1, kind: 'k', data: 1 }, 2, table)).toEqual({
      v: 2,
      kind: 'k',
      data: { up: 1 },
    });
    expect(() => upcastToCurrent({ v: 1, kind: 'k', data: 1 }, 3, table)).toThrow(/no upcaster v2/);
  });
});

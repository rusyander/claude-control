import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureEntry } from '../__fixtures__/registry.ts';
import { fixtureRecord, red } from '../red/__fixtures__/record.ts';
import { afterRecord, noteQuarantineRun, quarantineAdd, unquarantineCandidates } from './flaky.ts';
import { QUARANTINE_FILE, readQuarantine, writeQuarantine } from './quarantine-file.ts';

/**
 * Флаки (G4, P38 флаки-половина, P75): повтор только упавших тестов ≤2 раз, зелёный повтор —
 * доказанный переход и карантин сразу, два красных — красный; детерминированные классы не повторяются.
 */

const T = { file: 'apps/app/a.test.ts', name: 'a > works' };
const U = { file: 'apps/app/b.test.ts', name: 'b > also' };
const entry = fixtureEntry();

describe('verifier/flaky afterRecord (G4)', () => {
  it('a red unit record retries ONLY its failing tests; green retry → pass-flaky with retry ids + quarantine at once', () => {
    const original = red([T, U]);
    expect(afterRecord(original, entry, [])).toEqual({
      kind: 'retry',
      of: original.id,
      tests: [T, U],
      attempt: 1,
    });
    const retry1 = fixtureRecord({ grade: 'retry', passing: [T, U] });
    const plan = afterRecord(retry1, entry, [original]);
    expect(plan).toEqual({
      kind: 'pass-flaky',
      of: original.id,
      retries: [retry1.id],
      quarantine: [
        { test: T.name, file: T.file, checkId: 'tests', since: retry1.id, greensInRow: 0 },
        { test: U.name, file: U.file, checkId: 'tests', since: retry1.id, greensInRow: 0 },
      ],
    });
  });

  it('red retry → second retry of the still-failing tests; two red retries → red, never a third', () => {
    const original = red([T, U]);
    const retry1 = red([T], { grade: 'retry', passing: [U] });
    expect(afterRecord(retry1, entry, [original])).toEqual({
      kind: 'retry',
      of: original.id,
      tests: [T],
      attempt: 2,
    });
    const retry2 = red([T], { grade: 'retry' });
    expect(afterRecord(retry2, entry, [original, retry1])).toEqual({
      kind: 'red',
      of: original.id,
      retries: [retry1.id, retry2.id],
    });
    // U прошёл на первом повторе, T — на втором: каждый повторённый тест назван прошедшим
    const retry2green = fixtureRecord({ grade: 'retry', passing: [T] });
    expect(afterRecord(retry2green, entry, [original, retry1])).toMatchObject({
      kind: 'pass-flaky',
      retries: [retry1.id, retry2green.id],
    });
  });

  it('a green retry proves the flip only for tests it names passing: an unnamed or unproven retried test ends the chain red, nothing quarantined', () => {
    const original = red([T, U]);
    const partial = fixtureRecord({ grade: 'retry', passing: [T] });
    expect(afterRecord(partial, entry, [original])).toEqual({
      kind: 'red',
      of: original.id,
      retries: [partial.id],
    });
    // вывод прошедших не называет (P50): из двух имён ни одно не доказано
    const silent = fixtureRecord({ grade: 'retry' });
    expect(afterRecord(silent, entry, [original])).toMatchObject({ kind: 'red' });
    // один тест под своим именем — узкий зелёный засчитан только при ≥1 выполненном (narrowVerdict)
    const single = red([T]);
    expect(afterRecord(fixtureRecord({ grade: 'retry' }), entry, [single])).toMatchObject({
      kind: 'pass-flaky',
    });
    // тот же путь, но в другом файле — не этот тест
    const elsewhere = fixtureRecord({
      grade: 'retry',
      passing: [T, { file: 'apps/other/b.test.ts', name: U.name }],
    });
    expect(afterRecord(elsewhere, entry, [original])).toMatchObject({ kind: 'red' });
  });

  it.each([
    ['static class', fixtureEntry({ class: 'static' })],
    ['baseDependent', fixtureEntry({ baseDependent: true })],
    ['no narrow filter (a retry would rerun the whole unit)', fixtureEntry({ filter: undefined })],
    ['build class', fixtureEntry({ class: 'build' })],
  ])('deterministic or unnarrowable — never retried: %s', (_name, e) => {
    expect(afterRecord(red([T]), e, [])).toBeNull();
  });

  it('no retry for a pass, an unattributable red, an absent check, a no-verdict or a base record', () => {
    expect(afterRecord(fixtureRecord(), entry, [])).toBeNull();
    expect(afterRecord(red([]), entry, [])).toBeNull();
    expect(
      afterRecord(fixtureRecord({ verdict: { kind: 'fail', reason: 'absent' } }), entry, []),
    ).toBeNull();
    expect(
      afterRecord(fixtureRecord({ verdict: { kind: 'no-verdict', reason: 'stand' } }), entry, []),
    ).toBeNull();
    expect(afterRecord(red([T], { grade: 'base' }), entry, [])).toBeNull();
    const original = red([T]);
    const aborted = fixtureRecord({
      grade: 'retry',
      verdict: { kind: 'no-verdict', reason: 'aborted' },
    });
    expect(afterRecord(aborted, entry, [original])).toBeNull();
  });

  it('A1r2-F04 a red retries only when the parser named every failed test the runner counted', () => {
    // Итог раннера — 3 упавших, разобраны 2: повтор двух «зеленеет» при живом третьем.
    expect(afterRecord(red([T, U], { failedCount: 3 }), entry, [])).toBeNull();
    // Итога нет — сколько упало, неизвестно: красный стоит.
    expect(afterRecord(red([T, U], { failedCount: undefined }), entry, [])).toBeNull();
    expect(afterRecord(red([T, U], { failedCount: 2 }), entry, [])).toMatchObject({
      kind: 'retry',
      attempt: 1,
    });
    // Красный повтор с неразобранным упавшим — второго повтора нет, цепочка красная.
    const original = red([T, U], { failedCount: 2 });
    const retry1 = red([T], { grade: 'retry', failedCount: 2, passing: [U] });
    expect(afterRecord(retry1, entry, [original])).toEqual({
      kind: 'red',
      of: original.id,
      retries: [retry1.id],
    });
  });
});

describe('verifier/flaky quarantine (P75)', () => {
  const q = (over = {}) => ({
    test: T.name,
    file: T.file,
    checkId: 'tests',
    since: 'k.1',
    greensInRow: 0,
    ...over,
  });

  it('green unit runs count up per quarantined test in the unit; a red resets; 3 in a row → listed, never lifted', () => {
    const inApp = (f: string) => f.startsWith('apps/app/');
    const ranT = { passing: [T] };
    let list = quarantineAdd([], [q()]);
    expect(quarantineAdd(list, [q({ since: 'k.9' })])).toHaveLength(1);
    list = noteQuarantineRun(list, fixtureRecord(ranT), inApp);
    list = noteQuarantineRun(list, fixtureRecord(ranT), inApp);
    expect(list[0]?.greensInRow).toBe(2);
    list = noteQuarantineRun(list, red([T]), inApp);
    expect(list[0]?.greensInRow).toBe(0);
    for (let i = 0; i < 3; i += 1) list = noteQuarantineRun(list, fixtureRecord(ranT), inApp);
    expect(unquarantineCandidates(list).map((e) => e.test)).toEqual([T.name]);
    // чужая единица, повтор, сессия, другая проверка — счёт не трогают
    const before = list[0]?.greensInRow;
    list = noteQuarantineRun(list, fixtureRecord(ranT), () => false);
    list = noteQuarantineRun(list, fixtureRecord({ grade: 'retry', ...ranT }), inApp);
    list = noteQuarantineRun(list, fixtureRecord({ origin: 'session', ...ranT }), inApp);
    list = noteQuarantineRun(list, fixtureRecord({ checkId: 'lint', ...ranT }), inApp);
    list = noteQuarantineRun(list, red([]), inApp);
    expect(list[0]?.greensInRow).toBe(before);
  });

  it('a green unit run that never names the quarantined test passing does not count (skipped, renamed, deleted)', () => {
    const inApp = (f: string) => f.startsWith('apps/app/');
    let list = quarantineAdd([], [q()]);
    for (let i = 0; i < 3; i += 1)
      list = noteQuarantineRun(list, fixtureRecord({ passing: [U] }), inApp);
    list = noteQuarantineRun(list, fixtureRecord(), inApp);
    list = noteQuarantineRun(
      list,
      fixtureRecord({ passing: [{ file: 'apps/app/other.test.ts', name: T.name }] }),
      inApp,
    );
    expect(list[0]?.greensInRow).toBe(0);
    expect(unquarantineCandidates(list)).toEqual([]);
  });

  it('quarantine keys by (file, test): the same test path in another file is its own entry', () => {
    const list = quarantineAdd([q()], [q({ file: 'apps/admin/a.test.ts' })]);
    expect(list.map((e) => e.file)).toEqual([T.file, 'apps/admin/a.test.ts']);
  });

  it('quarantine.json round-trips; missing = empty; foreign shape or broken JSON = unknown, never empty', () => {
    const store = mkdtempSync(join(tmpdir(), 'quar-'));
    expect(readQuarantine(store)).toEqual({ value: [] });
    writeQuarantine(store, [q({ caseRef: { groupId: 'g', caseId: 'g-001' } })]);
    expect(readQuarantine(store)).toEqual({
      value: [q({ caseRef: { groupId: 'g', caseId: 'g-001' } })],
    });
    expect(JSON.parse(readFileSync(join(store, QUARANTINE_FILE), 'utf8')).v).toBe(1);
    writeFileSync(
      join(store, QUARANTINE_FILE),
      JSON.stringify({ v: 1, entries: [{ ...q(), x: 1 }] }),
    );
    expect(readQuarantine(store)).toMatchObject({ unknown: expect.stringMatching(/не по схеме/) });
    writeFileSync(join(store, QUARANTINE_FILE), '{');
    expect(readQuarantine(store)).toMatchObject({ unknown: expect.stringMatching(/не JSON/) });
  });
});

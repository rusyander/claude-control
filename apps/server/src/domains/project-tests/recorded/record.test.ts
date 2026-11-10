import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, readGroup, upsertCase } from '../store/store.ts';
import { RECORDED_MARK } from './codegen.ts';
import { RecordedHumanCaseError, recordWalk } from './record.ts';
import { recordedCases } from './history.ts';
import { walkRows } from './__fixtures__/walk-rows.ts';

const ORIGIN = 'http://127.0.0.1:4173';
const NOW = '2026-11-09T10:00:00.000Z';

describe('recorded record', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-recorded-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const body = (extra: Partial<Parameters<typeof recordWalk>[1]> = {}) => ({
    path: root,
    groupId: 'scenarios',
    title: 'Вход на стенд',
    taskId: '0190a000-0000-7000-8000-00000000abcd',
    ...walkRows(ORIGIN),
    ...extra,
  });

  it('writes the spec and links the case by file and the full test name', () => {
    const reply = recordWalk(root, body(), NOW);
    expect(reply).toMatchObject({
      groupId: 'scenarios',
      file: `.agent/tests/recorded/scenarios/${reply.caseId}.recorded.mjs`,
      testName: 'recorded > Вход на стенд',
      created: true,
      unchecked: 2,
    });
    const spec = readFileSync(join(root, reply.file), 'utf8');
    expect(spec.split('\n')[0]).toBe(`${RECORDED_MARK}recorded > Вход на стенд`);
    const saved = readGroup(root, 'scenarios').cases.find((item) => item.id === reply.caseId)!;
    expect(saved.automation).toEqual({
      status: 'automated',
      file: reply.file,
      testName: 'recorded > Вход на стенд',
    });
    expect(saved.source).toBe('agent');
    expect(saved.tags).toEqual(['recorded', 'browser']);
    expect(saved.attributes?.['recorded-task']).toBe(body().taskId);
    expect(saved.steps.filter((step) => step.action.startsWith('Не проверено'))).toHaveLength(2);
    expect(saved.steps).toHaveLength(8);
    expect(recordedCases(root)).toEqual([
      expect.objectContaining({ caseId: reply.caseId, unchecked: 2, history: [] }),
    ]);
  });

  it('re-recording the same rows into the same case leaves the spec byte-identical', () => {
    const first = recordWalk(root, body(), NOW);
    const before = readFileSync(join(root, first.file));
    const again = recordWalk(root, body({ caseId: first.caseId }), '2026-11-10T10:00:00.000Z');
    expect(again.caseId).toBe(first.caseId);
    expect(again.created).toBe(false);
    expect(readFileSync(join(root, again.file)).equals(before)).toBe(true);
  });

  it('refuses to overwrite a case written by a human, before any file is written', () => {
    createGroup(root, 'scenarios');
    const human = upsertCase(root, 'scenarios', { title: 'Ручной вход', steps: ['войти'] }, NOW);
    expect(() => recordWalk(root, body({ caseId: human.id }), NOW)).toThrow(RecordedHumanCaseError);
    expect(existsSync(join(root, '.agent/tests/recorded'))).toBe(false);
    expect(readGroup(root, 'scenarios').cases.find((item) => item.id === human.id)?.title).toBe(
      'Ручной вход',
    );
  });

  it('refuses a walk without a single passed step and rows the schema rejects', () => {
    const rows = walkRows(ORIGIN);
    const failedOnly = rows.steps.map((step) => ({ ...step, ok: false }));
    expect(() => recordWalk(root, body({ steps: failedOnly }), NOW)).toThrow(
      /ни одного удавшегося/,
    );
    const css = [{ ...rows.steps[0]!, target: { css: '#login' } }] as never;
    expect(() => recordWalk(root, body({ steps: css }), NOW)).toThrow(/не разобрались/);
  });
});

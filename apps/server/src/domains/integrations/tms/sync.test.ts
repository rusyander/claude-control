import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestRunRecord, TmsPushResult } from '@agentdeck/contracts';
import { createGroup, readGroup, upsertCase } from '../../project-tests/store.ts';
import { writeRun } from '../../project-tests/runs-store.ts';
import { pullIntoGroup, pushRunToTms } from './sync.ts';
import type { TmsClient, TmsRunPush } from './types.ts';

/**
 * Обмен с тест-менеджментом. Проверяется то, ради чего заведена пометка
 * `tms:<ключ>`: повторный забор не плодит дубликаты, чужая правка кейса не
 * затирается, а результат уходит только тому кейсу, чей ключ известен.
 */

let project = '';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cc-tms-'));
  createGroup(project, 'gui', 'GUI');
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const NOW = '2026-09-07T10:00:00.000Z';

const cases = [
  { key: 'GOR-T1', title: 'Вход', steps: [{ action: 'нажать', expected: 'открылось' }] },
  { key: 'GOR-T2', title: 'Выход', steps: [] },
];

describe('tms/sync: забор кейсов', () => {
  it('кейсы приезжают с пометкой источника и ссылкой', () => {
    const result = pullIntoGroup(
      project,
      'gui',
      [{ ...cases[0]!, url: 'https://jira/GOR-T1' }],
      NOW,
    );
    expect(result).toEqual({ imported: 1, skipped: 0 });

    const stored = readGroup(project, 'gui').cases[0]!;
    expect(stored.title).toBe('Вход');
    expect(stored.tags).toEqual(['tms:GOR-T1']);
    expect(stored.steps[0]).toMatchObject({ action: 'нажать', expected: 'открылось' });
    expect(stored.links?.[0]).toMatchObject({ url: 'https://jira/GOR-T1', title: 'GOR-T1' });
  });

  it('повторный забор ничего не дублирует и не затирает правку человека', () => {
    pullIntoGroup(project, 'gui', cases, NOW);
    const stored = readGroup(project, 'gui').cases[0]!;
    upsertCase(project, 'gui', { id: stored.id, title: 'Вход (уточнено)', steps: [] }, NOW);

    const again = pullIntoGroup(project, 'gui', cases, NOW);
    expect(again).toEqual({ imported: 0, skipped: 2 });
    const after = readGroup(project, 'gui');
    expect(after.cases).toHaveLength(2);
    expect(after.cases.find((item) => item.id === stored.id)?.title).toBe('Вход (уточнено)');
  });

  it('кейс без ключа пропускается: связать его не с чем', () => {
    expect(pullIntoGroup(project, 'gui', [{ key: '', title: 'Ничей', steps: [] }], NOW)).toEqual({
      imported: 0,
      skipped: 1,
    });
    expect(readGroup(project, 'gui').cases).toHaveLength(0);
  });
});

describe('tms/sync: отправка прогона', () => {
  const run: ProjectTestRunRecord = {
    id: 'run-1',
    mode: 'run',
    actor: 'agent',
    status: 'done',
    startedAt: NOW,
    results: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  };

  function fakeClient(seen: TmsRunPush[]): TmsClient {
    return {
      title: 'Fake',
      ping: () => Promise.resolve('ok'),
      pullCases: () => Promise.resolve([]),
      pushRun: (push): Promise<TmsPushResult> => {
        seen.push(push);
        return Promise.resolve({ pushed: run.results.length });
      },
    };
  }

  it('нет такого прогона — 404 с его именем', async () => {
    await expect(pushRunToTms(fakeClient([]), project, 'нет')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('внешний ключ поднимается с кейса, а не выдумывается по результату', async () => {
    pullIntoGroup(project, 'gui', cases, NOW);
    const stored = readGroup(project, 'gui').cases;
    writeRun(project, {
      ...run,
      results: [
        { pointId: 'p1', groupId: 'gui', caseId: stored[0]!.id, status: 'failed' },
        { pointId: 'p2', groupId: 'gui', caseId: 'нет-такого', status: 'passed' },
      ],
    });

    const seen: TmsRunPush[] = [];
    await pushRunToTms(fakeClient(seen), project, 'run-1');
    const keyOf = seen[0]!.keyOf;
    expect(keyOf({ pointId: 'p1', groupId: 'gui', caseId: stored[0]!.id, status: 'failed' })).toBe(
      'GOR-T1',
    );
    expect(
      keyOf({ pointId: 'p2', groupId: 'gui', caseId: 'нет-такого', status: 'passed' }),
    ).toBeUndefined();
  });
});

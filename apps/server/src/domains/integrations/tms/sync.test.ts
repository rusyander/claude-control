import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestRunRecord, TmsPushResult } from '@agentdeck/contracts';
import { createGroup, readGroup, upsertCase } from '../../project-tests/store.ts';
import { readRun, writeRun } from '../../project-tests/runs-store.ts';
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

/** Клиент-заглушка: запоминает, о чём его попросили, и отвечает заданным. */
function fakeClient(
  seen: TmsRunPush[],
  answer: TmsPushResult = { pushed: 0 },
  kind: TmsClient['kind'] = 'zephyr',
): TmsClient {
  return {
    kind,
    title: 'Fake',
    ping: () => Promise.resolve('ok'),
    pullCases: () => Promise.resolve({ cases: [] }),
    pushRun: (push): Promise<TmsPushResult> => {
      seen.push(push);
      return Promise.resolve(answer);
    },
  };
}

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

  it('след отправки ложится в запись прогона и переживает чтение с диска', async () => {
    writeRun(project, run);
    await pushRunToTms(
      fakeClient([], { pushed: 3, runId: 'tr-77', url: 'https://tms/tr-77' }),
      project,
      'run-1',
      NOW,
    );

    expect(readRun(project, 'run-1')?.tms).toEqual({
      kind: 'zephyr',
      runId: 'tr-77',
      url: 'https://tms/tr-77',
      pushed: 3,
      pushedAt: NOW,
    });
  });

  it('повторная отправка называет клиенту УЖЕ заведённый ран', async () => {
    writeRun(project, {
      ...run,
      tms: { kind: 'zephyr', runId: 'tr-77', pushed: 3, pushedAt: NOW },
    });

    const seen: TmsRunPush[] = [];
    await pushRunToTms(
      fakeClient(seen, { pushed: 3, runId: 'tr-77', reused: true }),
      project,
      'run-1',
    );
    expect(seen[0]!.externalRunId).toBe('tr-77');
  });

  it('след ЧУЖОЙ системы не подставляется: идентификаторы несовместимы', async () => {
    writeRun(project, {
      ...run,
      tms: { kind: 'zephyr', runId: 'tr-77', pushed: 3, pushedAt: NOW },
    });

    const seen: TmsRunPush[] = [];
    await pushRunToTms(fakeClient(seen, { pushed: 0, runId: 'x-1' }, 'testit'), project, 'run-1');
    expect(seen[0]!.externalRunId).toBeUndefined();
    expect(readRun(project, 'run-1')?.tms?.kind).toBe('testit');
  });

  it('отправка не удалась ДО создания рана — след не пишется, завести ещё можно', async () => {
    writeRun(project, run);
    const failing: TmsClient = {
      ...fakeClient([]),
      pushRun: () => Promise.reject(new Error('сеть')),
    };

    await expect(pushRunToTms(failing, project, 'run-1')).rejects.toThrow('сеть');
    expect(readRun(project, 'run-1')?.tms).toBeUndefined();
  });
});

/**
 * Находки враждебного ревью Т9. Каждая проверка ходит через `pushRunToTms` —
 * тот самый вход, которым пользуется маршрут: разбор внутренностей домена
 * доказал бы форму функции, а не то, что двойной ран больше не заводится.
 */
describe('tms/sync: находки ревью Т9', () => {
  const run: ProjectTestRunRecord = {
    id: 'run-1',
    mode: 'run',
    actor: 'agent',
    status: 'done',
    startedAt: NOW,
    results: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  };

  /** Клиент, чья отправка держится, пока тест сам её не отпустит. */
  function heldClient(): { client: TmsClient; release: () => void; started: number } {
    const state = { started: 0 };
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: TmsClient = {
      kind: 'zephyr',
      title: 'Fake',
      ping: () => Promise.resolve('ok'),
      pullCases: () => Promise.resolve({ cases: [] }),
      pushRun: async (): Promise<TmsPushResult> => {
        state.started += 1;
        await held;
        return { pushed: 1, runId: 'tr-77', url: 'https://tms/tr-77' };
      },
    };
    return {
      client,
      release,
      get started() {
        return state.started;
      },
    };
  }

  it('H4: вторая одновременная отправка того же прогона получает 409, а не свой ран', async () => {
    writeRun(project, run);
    const held = heldClient();

    const first = pushRunToTms(held.client, project, 'run-1', NOW);
    // Дать первой дойти до клиента: замок берётся до обращения наружу.
    await Promise.resolve();
    const second = pushRunToTms(held.client, project, 'run-1', NOW);

    await expect(second).rejects.toMatchObject({ statusCode: 409, code: 'integration_busy' });
    held.release();
    await expect(first).resolves.toMatchObject({ runId: 'tr-77' });
    // Наружу ушла ровно одна отправка — иначе в чужой системе было бы два рана.
    expect(held.started).toBe(1);
  });

  it('H4: замок снимается — следующая отправка проходит обычным порядком', async () => {
    writeRun(project, run);
    const held = heldClient();
    const first = pushRunToTms(held.client, project, 'run-1', NOW);
    held.release();
    await first;

    const seen: TmsRunPush[] = [];
    await expect(
      pushRunToTms(fakeClient(seen, { pushed: 1, runId: 'tr-77', reused: true }), project, 'run-1'),
    ).resolves.toMatchObject({ reused: true });
  });

  it('H4: замок на ОДИН прогон — соседний отправляется одновременно', async () => {
    writeRun(project, run);
    writeRun(project, { ...run, id: 'run-2' });
    const held = heldClient();

    const first = pushRunToTms(held.client, project, 'run-1', NOW);
    await Promise.resolve();
    const other = pushRunToTms(fakeClient([], { pushed: 1, runId: 'tr-2' }), project, 'run-2', NOW);
    await expect(other).resolves.toMatchObject({ runId: 'tr-2' });
    held.release();
    await first;
  });

  it('H5: ран заведён, а результаты упали — след остался, и второй ран не заводится', async () => {
    writeRun(project, run);
    const breaking: TmsClient = {
      ...fakeClient([]),
      pushRun: (push) => {
        push.onRunCreated?.('tr-77', 'https://tms/tr-77');
        return Promise.reject(new Error('сеть на середине'));
      },
    };

    await expect(pushRunToTms(breaking, project, 'run-1', NOW)).rejects.toThrow('сеть на середине');
    expect(readRun(project, 'run-1')?.tms).toEqual({
      kind: 'zephyr',
      runId: 'tr-77',
      url: 'https://tms/tr-77',
      pushed: 0,
      pushedAt: NOW,
    });

    // И главное: повторная отправка кладёт результаты В ТОТ ЖЕ ран.
    const seen: TmsRunPush[] = [];
    await pushRunToTms(
      fakeClient(seen, { pushed: 2, runId: 'tr-77', reused: true }),
      project,
      'run-1',
    );
    expect(seen[0]!.externalRunId).toBe('tr-77');
  });

  it('M3: пустая повторная отправка не стирает адрес рана и не обнуляет счёт', async () => {
    writeRun(project, {
      ...run,
      tms: { kind: 'zephyr', runId: 'tr-77', url: 'https://tms/tr-77', pushed: 3, pushedAt: NOW },
    });

    // Клиент, которому нечего отправлять, отвечает голым `{ pushed: 0 }` — без
    // ключа рана и без ссылки. Раньше этим ответом затирался живой след.
    await pushRunToTms(fakeClient([], { pushed: 0 }), project, 'run-1', '2026-09-08T10:00:00.000Z');

    expect(readRun(project, 'run-1')?.tms).toEqual({
      kind: 'zephyr',
      runId: 'tr-77',
      url: 'https://tms/tr-77',
      pushed: 3,
      pushedAt: '2026-09-08T10:00:00.000Z',
    });
  });

  it('M3: удачная отправка в тот же ран обновляет счёт и ссылку', async () => {
    writeRun(project, {
      ...run,
      tms: { kind: 'zephyr', runId: 'tr-77', url: 'https://tms/old', pushed: 3, pushedAt: NOW },
    });

    await pushRunToTms(
      fakeClient([], { pushed: 5, runId: 'tr-77', url: 'https://tms/tr-77', reused: true }),
      project,
      'run-1',
      NOW,
    );

    expect(readRun(project, 'run-1')?.tms).toMatchObject({
      runId: 'tr-77',
      url: 'https://tms/tr-77',
      pushed: 5,
    });
  });

  it('M3: ДРУГОЙ ран пишется начисто — старый счёт к нему не относится', async () => {
    writeRun(project, {
      ...run,
      tms: { kind: 'zephyr', runId: 'tr-77', url: 'https://tms/tr-77', pushed: 3, pushedAt: NOW },
    });

    await pushRunToTms(fakeClient([], { pushed: 0, runId: 'tr-99' }), project, 'run-1', NOW);
    expect(readRun(project, 'run-1')?.tms).toEqual({
      kind: 'zephyr',
      runId: 'tr-99',
      url: undefined,
      pushed: 0,
      pushedAt: NOW,
    });
  });
});

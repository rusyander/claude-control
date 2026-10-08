import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Сбои файловой системы посреди ручного прохода (F-352, F-353).
 *
 * Подменяется только граница — запись на диск, которая на Windows падает
 * EPERM/EBUSY, пока файл держит антивирус или индексатор. Реестр, разбор
 * сессии и записи прогонов — настоящие.
 */
const faults = vi.hoisted(() => ({ writeRun: 0, removeEntry: 0 }));

vi.mock('../runs-store/runs-store.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../runs-store/runs-store.ts')>();
  return {
    ...real,
    writeRun: (...args: Parameters<typeof real.writeRun>) => {
      if (faults.writeRun > 0) {
        faults.writeRun -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      real.writeRun(...args);
    },
  };
});

vi.mock('../../../lib/safe-io/safe-io.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/safe-io/safe-io.ts')>();
  return {
    ...real,
    removeEntry: (target: string) => {
      if (faults.removeEntry > 0) {
        faults.removeEntry -= 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), {
          code: 'EBUSY',
        });
      }
      real.removeEntry(target);
    },
  };
});

const { ProjectTestManualRegistry } = await import('./manual.ts');
const { createGroup, upsertCase } = await import('../store/store.ts');
const { readRuns, writeRun } = await import('../runs-store/runs-store.ts');

describe('project-tests/manual: сбои диска', () => {
  let project = '';
  const now = '2026-09-28T10:00:00.000Z';
  const sessionFile = () => join(project, '.agent', 'tests', 'runs', 'manual.session.json');

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-manual-faults-'));
    faults.writeRun = 0;
    faults.removeEntry = 0;
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть'] }, now);
    upsertCase(project, 'gui', { title: 'Выход', steps: ['нажать'] }, now);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * F-352: подъём сессии заодно закрывает брошенные записи. Раньше проект
   * помечался «уже поднят» ДО подъёма — упала запись брошенной записи, и
   * идущая сессия на диске в этом процессе больше не поднималась, а следующий
   * start() затирал её файл.
   */
  it('сбой записи при подъёме не теряет идущую сессию', () => {
    const session = new ProjectTestManualRegistry().start(project, { groupId: 'gui' }, now);
    writeRun(project, {
      id: 'stale',
      mode: 'manual',
      actor: 'human',
      status: 'running',
      startedAt: '2026-09-27T10:00:00.000Z',
      results: [],
      summary: { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
    } as Parameters<typeof writeRun>[1]);

    const restarted = new ProjectTestManualRegistry();
    faults.writeRun = 1;
    let first: ReturnType<typeof restarted.get>;
    try {
      first = restarted.get(project);
    } catch {
      first = undefined;
    }
    const second = restarted.get(project);

    expect(first?.runId ?? second?.runId).toBe(session.runId);
    expect(second?.runId).toBe(session.runId);
    // Брошенная запись закрывается при следующей попытке, а не остаётся «идёт».
    expect(readRuns(project).find((run) => run.id === 'stale')?.status).toBe('stopped');
    expect(readRuns(project).find((run) => run.id === session.runId)?.status).toBe('running');
    expect(readRuns(project).find((run) => run.id === 'stale')?.status).toBe('stopped');
  });

  /**
   * F-353: завершение пишет запись «done», потом удаляет файл сессии. EBUSY на
   * удалении раньше давал ошибку маршрута после уже закрытой записи, а
   * оставшийся файл при следующем старте воскрешал законченный проход «идёт».
   */
  it('неудалённый файл законченной сессии не воскрешает проход', () => {
    const manual = new ProjectTestManualRegistry();
    const session = manual.start(project, { groupId: 'gui' }, now);
    faults.removeEntry = 1;

    expect(() => manual.finish(project, session.runId, '2026-09-28T10:05:00.000Z')).not.toThrow();
    expect(readRuns(project)[0]?.status).toBe('done');
    expect(existsSync(sessionFile())).toBe(true);

    const restarted = new ProjectTestManualRegistry();
    expect(restarted.get(project)).toBeUndefined();
    expect(readRuns(project)[0]?.status).toBe('done');
    // Новый проход начинается, а не упирается в «уже идёт».
    expect(restarted.start(project, { groupId: 'gui' }, now).runId).not.toBe(session.runId);
  });

  it('файл законченной сессии, оставшийся от прежней версии, тоже не поднимается', () => {
    const manual = new ProjectTestManualRegistry();
    const session = manual.start(project, { groupId: 'gui' }, now);
    const kept = join(project, 'kept.session.json');
    copyFileSync(sessionFile(), kept);
    manual.finish(project, session.runId, '2026-09-28T10:05:00.000Z');
    copyFileSync(kept, sessionFile());

    expect(new ProjectTestManualRegistry().get(project)).toBeUndefined();
    expect(readRuns(project)[0]?.status).toBe('done');
  });
});

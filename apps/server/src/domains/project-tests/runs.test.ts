import type { ProjectTestEnvironment } from '@agentdeck/contracts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectTestsError, ProjectTestsNotFoundError } from './files.ts';
import {
  ProjectTestRunRegistry,
  collectResults,
  fingerprintCases,
  pickEnvironmentId,
  stampRunResults,
} from './runs.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';
import type { ProjectTestRun } from '@agentdeck/contracts';

/**
 * Реестр прогонов спавнит настоящий CLI, поэтому юнитами проверяется то, что
 * решается ДО запуска, — здесь выбор окружения.
 *
 * Случай «ничего не выбрали» и есть тот, из-за которого прогон уходил без
 * адреса стенда и без его доступов: пульт с выбором «по умолчанию» не шлёт
 * `environmentId` вовсе.
 */
describe('project-tests/runs: окружение прогона', () => {
  const environments: ProjectTestEnvironment[] = [
    { id: 'local', title: 'Локальное' },
    { id: 'stand', title: 'Стенд', isDefault: true },
    { id: 'old', title: 'Старый', archived: true, isDefault: true },
  ];

  it('названное человеком побеждает всё остальное', () => {
    expect(pickEnvironmentId(environments, 'local', 'stand')).toBe('local');
  });

  it('не названо — берётся окружение плана', () => {
    expect(pickEnvironmentId(environments, undefined, 'local')).toBe('local');
  });

  it('не названо и плана нет — подставляется окружение по умолчанию', () => {
    expect(pickEnvironmentId(environments, undefined, undefined)).toBe('stand');
  });

  it('окружений нет вовсе — прогон идёт без окружения, а не падает', () => {
    expect(pickEnvironmentId([], undefined, undefined)).toBeUndefined();
  });

  it('архивное окружение по умолчанию не всплывает', () => {
    expect(pickEnvironmentId([environments[2]!], undefined, undefined)).toBeUndefined();
  });
});

/**
 * Отбор проверяется ДО старта. Раньше прогон с опечаткой в id стартовал,
 * тратил токены по пустому отбору и заканчивался «нечего»; здесь агент не
 * запускается ни в одной проверке — отказ приходит раньше запуска CLI.
 * Форма «группа:кейс» принимается: её пишут планы и ручной проход.
 */
describe('project-tests/runs: отбор до старта', () => {
  let root = '';
  const now = '2026-09-08T10:00:00.000Z';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-runs-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'Вход', steps: ['открыть'] }, now);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('неизвестная группа — 404 до запуска агента', () => {
    const registry = new ProjectTestRunRegistry();

    expect(() => registry.start({ projectPath: root, mode: 'run', groupId: 'nope' }, now)).toThrow(
      ProjectTestsNotFoundError,
    );
    expect(registry.get(root)).toBeUndefined();
  });

  it('опечатка в id кейса названа в отказе, прогон не стартует', () => {
    const registry = new ProjectTestRunRegistry();

    expect(() =>
      registry.start(
        { projectPath: root, mode: 'run', groupId: 'gui', caseIds: ['gui-001', 'gui-777'] },
        now,
      ),
    ).toThrow(/gui-777/);
    expect(registry.get(root)).toBeUndefined();
  });

  it('форма «группа:кейс» проходит отбор', () => {
    const registry = new ProjectTestRunRegistry();

    // Отбор принял id — дальше споткнулось уже исследование без хартии,
    // то есть проверка, идущая ПОСЛЕ отбора. Агент так и не запущен.
    expect(() =>
      registry.start(
        { projectPath: root, mode: 'explore', groupId: 'gui', caseIds: ['gui:gui-001'] },
        now,
      ),
    ).toThrow(/хартии/);
    expect(() =>
      registry.start(
        { projectPath: root, mode: 'explore', groupId: 'gui', caseIds: ['gui:gui-777'] },
        now,
      ),
    ).toThrow(ProjectTestsError);
  });
});

/**
 * Результаты прогона — по штампу панели, не по часам агента. Живой прогон
 * 08.09 писал `lastRunAt` местным временем с буквой Z (на пять часов в
 * будущем), и каждая следующая генерация собирала чужие результаты в свою
 * запись.
 */
describe('project-tests/runs: штамп результатов', () => {
  let root = '';
  const startedAt = '2026-09-08T14:21:51.000Z';
  const finishedAt = '2026-09-08T14:23:03.000Z';
  const view = (extra: Partial<ProjectTestRun> = {}): ProjectTestRun => ({
    id: 'run-1',
    projectPath: root,
    mode: 'run',
    actor: 'agent',
    groupId: 'api',
    status: 'done',
    startedAt,
    finishedAt,
    log: '',
    tokens: 0,
    costUsd: 0,
    ...extra,
  });
  const write = (id: string, patch: Record<string, unknown>) => {
    const file = join(root, '.agent', 'tests', 'api.tests.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.cases = data.cases.map((item: { id: string }) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    writeFileSync(file, JSON.stringify(data, null, 2));
  };
  const caseOf = (id: string) =>
    readGroups(root)
      .find((g) => g.id === 'api')
      ?.cases.find((c) => c.id === id);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-stamp-'));
    createGroup(root, 'api');
    upsertCase(root, 'api', { title: 'A', steps: ['x'] }, startedAt);
    upsertCase(root, 'api', { title: 'B', steps: ['y'] }, startedAt);
    upsertCase(root, 'api', { title: 'C', steps: ['z'] }, startedAt);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('тронутый кейс получает lastRunId, а время из будущего — втискивается в прогон', () => {
    const snapshot = fingerprintCases(readGroups(root), view());
    write('api-001', { status: 'passed', note: 'ок', lastRunAt: '2026-09-08T19:22:00.000Z' });
    write('api-002', { status: 'failed', note: 'упало', lastRunAt: '2026-09-08T14:22:30.000Z' });

    expect(stampRunResults(root, view(), snapshot, finishedAt)).toBe(2);
    expect(caseOf('api-001')).toMatchObject({ lastRunId: 'run-1', lastRunAt: finishedAt });
    expect(caseOf('api-002')).toMatchObject({
      lastRunId: 'run-1',
      lastRunAt: '2026-09-08T14:22:30.000Z',
    });
    expect(caseOf('api-003')?.lastRunId).toBeUndefined();

    const results = collectResults(root, view());
    expect(results.map((r) => [r.caseId, r.status])).toEqual([
      ['api-001', 'passed'],
      ['api-002', 'failed'],
    ]);
  });

  it('чужой результат с временем позже старта в запись не попадает', () => {
    // Прошлый прогон оставил будущее время — отпечаток при старте его уже видит.
    write('api-001', {
      status: 'passed',
      lastRunAt: '2026-09-08T19:22:00.000Z',
      lastRunId: 'run-0',
    });
    const snapshot = fingerprintCases(readGroups(root), view());

    expect(stampRunResults(root, view(), snapshot, finishedAt)).toBe(0);
    expect(collectResults(root, view())).toEqual([]);
    expect(caseOf('api-001')?.lastRunId).toBe('run-0');
  });

  it('генерация результатов не даёт, даже если кейсы отбора красные', () => {
    write('api-001', { status: 'failed', lastRunAt: finishedAt, lastRunId: 'run-1' });

    expect(collectResults(root, view({ mode: 'generate' }))).toEqual([]);
    expect(collectResults(root, view())).toHaveLength(1);
  });

  it('отбор по id штампует только свои кейсы', () => {
    const scoped = view({ caseIds: ['api-002'] });
    const snapshot = fingerprintCases(readGroups(root), scoped);
    write('api-001', { status: 'passed', lastRunAt: finishedAt });
    write('api-002', { status: 'passed', lastRunAt: finishedAt });

    expect(stampRunResults(root, scoped, snapshot, finishedAt)).toBe(1);
    expect(caseOf('api-001')?.lastRunId).toBeUndefined();
    expect(collectResults(root, scoped).map((r) => r.caseId)).toEqual(['api-002']);
  });
});

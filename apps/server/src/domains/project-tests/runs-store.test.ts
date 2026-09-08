import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestPointResult, ProjectTestRunRecord } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  evidenceOf,
  failureGroups,
  flakyCases,
  readRun,
  readRuns,
  runFileId,
  writeRun,
} from './runs-store.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';

/**
 * История прогонов на диске.
 *
 * Проверяется то, ради чего она вообще заведена: порядок «от новых к старым»
 * (иначе отчёт показывает позапрошлую неделю), устойчивость к чужому неполному
 * файлу и расчёт нестабильных кейсов — тех, что мигают при неизменном коде.
 */
describe('project-tests/runs-store', () => {
  let project = '';

  const record = (
    id: string,
    startedAt: string,
    results: Partial<ProjectTestPointResult>[] = [],
  ): ProjectTestRunRecord => ({
    id,
    mode: 'run',
    actor: 'agent',
    status: 'done',
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    tokens: 1000,
    costUsd: 0.5,
    results: results.map((item, index) => ({
      pointId: `gui:gui-00${index + 1}`,
      groupId: 'gui',
      caseId: `gui-00${index + 1}`,
      status: 'passed',
      ...item,
    })) as ProjectTestPointResult[],
    summary: { total: results.length, passed: results.length, failed: 0, skipped: 0, blocked: 0 },
  });

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-runs-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('прогоны читаются от новых к старым', () => {
    writeRun(project, record('aaaaaaaa', '2026-09-01T10:00:00.000Z'));
    writeRun(project, record('bbbbbbbb', '2026-09-05T10:00:00.000Z'));

    expect(readRuns(project).map((run) => run.id)).toEqual(['bbbbbbbb', 'aaaaaaaa']);
  });

  it('прогон читается по идентификатору файла', () => {
    const run = record('cccccccc', '2026-09-03T09:30:00.000Z');
    writeRun(project, run);

    expect(readRun(project, runFileId(run.id, run.startedAt))?.id).toBe('cccccccc');
  });

  /**
   * Список отдаёт записи под их собственным `id`, а имя файла хронологическое.
   * Принимай чтение только имя файла — прогон из истории было бы не открыть.
   */
  it('прогон читается и по собственному идентификатору, который отдал список', () => {
    writeRun(project, record('dddddddd', '2026-09-04T08:00:00.000Z'));
    const listed = readRuns(project)[0];

    expect(readRun(project, listed?.id ?? '')?.id).toBe('dddddddd');
    expect(readRun(project, 'нет-такого')).toBeUndefined();
  });

  it('мигающий кейс попадает в нестабильные, ровный — нет', () => {
    const runs: ProjectTestRunRecord[] = [
      record('r3', '2026-09-03T10:00:00.000Z', [{ status: 'failed' }, { status: 'passed' }]),
      record('r2', '2026-09-02T10:00:00.000Z', [{ status: 'passed' }, { status: 'passed' }]),
      record('r1', '2026-09-01T10:00:00.000Z', [{ status: 'failed' }, { status: 'passed' }]),
    ];

    const flaky = flakyCases(runs, []);

    expect(flaky.map((item) => item.caseId)).toEqual(['gui-001']);
    expect(flaky[0]?.flips).toBe(2);
    expect(flaky[0]?.stability).toBeLessThan(100);
  });

  /**
   * Разные числа в тексте — та же поломка: без этого одна упавшая авторизация
   * разъезжается на столько причин, сколько было прогонов.
   */
  it('провалы с одной причиной сводятся, а безымянные не считаются', () => {
    const runs: ProjectTestRunRecord[] = [
      record('r2', '2026-09-02T10:00:00.000Z', [
        { status: 'failed', note: 'Таймаут 30000 мс на входе' },
        { status: 'failed' },
      ]),
      record('r1', '2026-09-01T10:00:00.000Z', [
        { status: 'failed', note: 'таймаут 5000 мс на входе' },
        { status: 'blocked', note: 'нет тестовой учётки' },
      ]),
    ];

    const failures = failureGroups(runs, []);

    expect(failures).toHaveLength(2);
    expect(failures[0]?.count).toBe(2);
    expect(failures[0]?.reason).toBe('Таймаут 30000 мс на входе');
    expect(failures[0]?.cases.map((one) => one.caseId)).toEqual(['gui-001']);
    expect(failures[1]?.reason).toBe('нет тестовой учётки');
  });

  it('отчёт считает зоны, автоматизацию и расход', () => {
    createGroup(project, 'gui', 'GUI');
    upsertCase(
      project,
      'gui',
      { title: 'Вход', steps: [], area: 'auth' },
      '2026-09-01T10:00:00.000Z',
    );
    upsertCase(
      project,
      'gui',
      {
        title: 'Чат',
        steps: [],
        area: 'chat',
        automation: { status: 'automated', file: 'e2e/chat.spec.ts' },
      },
      '2026-09-01T10:00:00.000Z',
    );
    writeRun(project, record('rrrrrrrr', '2026-09-06T10:00:00.000Z', [{ status: 'passed' }]));

    const report = buildReport(project, readGroups(project));

    expect(report.totals.runs).toBe(1);
    expect(report.totals.tokens).toBe(1000);
    expect(report.totals.durationMs).toBe(60_000);
    expect(report.areas.map((row) => row.area).sort()).toEqual(['auth', 'chat']);
    expect(report.automation).toEqual({ manual: 1, toAutomate: 0, automated: 1 });
  });

  /**
   * Доказательность провала. Ради этого счёта поле `attachments` в результате и
   * существует: провал без снимка нельзя ни воспроизвести, ни завести дефектом,
   * а молча выбросить его нельзя — это полчаса работы прогона.
   */
  it('провал без вложения назван недоказанным, с вложением — доказанным', () => {
    const summary = evidenceOf(
      [
        record('r1', '2026-09-05T10:00:00.000Z', [
          { status: 'failed', attachments: ['.agent/tests/attachments/gui-001/1.png'] },
          { status: 'failed' },
          { status: 'passed' },
        ]),
      ],
      [],
    );

    expect(summary.failed).toBe(2);
    expect(summary.proven).toBe(1);
    expect(summary.missing.map((item) => item.caseId)).toEqual(['gui-002']);
  });

  it('считается последний провал кейса, а не все подряд', () => {
    const summary = evidenceOf(
      [
        record('r2', '2026-09-06T10:00:00.000Z', [{ status: 'failed' }]),
        record('r1', '2026-09-05T10:00:00.000Z', [
          { status: 'failed', attachments: ['старый-снимок.png'] },
        ]),
      ],
      [],
    );

    // Провал, доказанный месяц назад и голословный сегодня, — голословный.
    expect(summary.failed).toBe(1);
    expect(summary.proven).toBe(0);
    expect(summary.missing).toHaveLength(1);
  });

  it('разбор провала и разошедшиеся попытки считаются отдельно', () => {
    const summary = evidenceOf(
      [
        record('r1', '2026-09-05T10:00:00.000Z', [
          { status: 'failed', failure: { step: 3, actual: 'кнопка не нажимается' } },
          { status: 'blocked', failure: { retry: 'flaky', retryNote: 'со второго раза прошло' } },
        ]),
      ],
      [],
    );

    expect(summary.detailed).toBe(1);
    expect(summary.flaky.map((item) => item.caseId)).toEqual(['gui-002']);
    // Блокировка — тоже красное: результата у кейса нет и доказывать нечем.
    expect(summary.failed).toBe(2);
  });

  it('название кейса подтягивается из библиотеки: в записи прогона его нет', () => {
    const summary = evidenceOf(
      [record('r1', '2026-09-05T10:00:00.000Z', [{ status: 'failed' }])],
      [
        {
          id: 'gui',
          title: 'GUI',
          file: 'f',
          cases: [
            {
              id: 'gui-001',
              type: 'case',
              title: 'Вход',
              steps: [],
              status: 'failed',
              source: 'agent',
            },
          ],
        },
      ],
    );

    expect(summary.missing[0]?.title).toBe('Вход');
  });

  it('чужой неполный файл пропускается, а не роняет историю', () => {
    writeRun(project, record('gggggggg', '2026-09-04T10:00:00.000Z'));
    // Запись без времени старта — по ней нельзя сказать даже, когда это было.
    writeRun(project, {
      ...record('hhhhhhhh', '2026-09-05T10:00:00.000Z'),
      startedAt: '',
    } as ProjectTestRunRecord);

    expect(readRuns(project).map((run) => run.id)).toEqual(['gggggggg']);
  });
});

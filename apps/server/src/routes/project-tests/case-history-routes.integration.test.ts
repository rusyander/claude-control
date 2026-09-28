import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProjectTestCaseHistory,
  ProjectTestFlakyMarks,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { writeRun } from '../../domains/project-tests/runs-store.ts';
import type { TestsDeps } from './shared.ts';
import { registerTestCaseHistoryRoutes } from './case-history-routes.ts';

/**
 * История кейса по HTTP: ответ строится из записей прогонов на диске, кейс без
 * имени отбивается 400 с кодом, а отметки нестабильности приходят вместе с
 * правилом — подсказке в интерфейсе нужно его назвать.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const record = (
  id: string,
  startedAt: string,
  status: 'passed' | 'failed',
): ProjectTestRunRecord => ({
  id,
  mode: 'run',
  actor: 'agent',
  status: 'done',
  startedAt,
  results: [{ pointId: 'gui:gui-001', groupId: 'gui', caseId: 'gui-001', status }],
  summary: { total: 1, passed: 0, failed: 0, skipped: 0, blocked: 0 },
});

describe('project-tests case history routes', () => {
  let app: FastifyInstance;
  let project = '';

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-case-history-'));
    mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
    writeRun(project, record('aaaaaaaa', '2026-09-01T10:00:00.000Z', 'passed'));
    writeRun(project, record('bbbbbbbb', '2026-09-02T10:00:00.000Z', 'failed'));
    writeRun(project, record('cccccccc', '2026-09-03T10:00:00.000Z', 'passed'));

    app = Fastify();
    registerTestCaseHistoryRoutes(app, {} as unknown as TestsDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(project);
  });

  it('история кейса — от новых к старым, с вердиктом', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/case-history',
      query: { path: project, groupId: 'gui', caseId: 'gui-001' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ProjectTestCaseHistory>();
    expect(body.entries.map((entry) => entry.runId)).toEqual(['cccccccc', 'bbbbbbbb', 'aaaaaaaa']);
    expect(body.flaky).toEqual({ isFlaky: true, flips: 2, runs: 3 });
  });

  it('кейс не назван — 400 с кодом', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/case-history',
      query: { path: project, groupId: 'gui' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'case-history-case-unspecified' });
  });

  it('отметки нестабильности приходят с правилом', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/flaky',
      query: { path: project },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ProjectTestFlakyMarks>();
    expect(body.cases).toEqual([
      { groupId: 'gui', caseId: 'gui-001', isFlaky: true, flips: 2, runs: 3 },
    ]);
    expect(body.minFlips).toBe(2);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RoutePrice } from '@agentdeck/contracts/core/routes';
import { taskViewSchema } from '@agentdeck/contracts/core/task-view';
import { journalUsage } from '../bootstrap/economy-wiring/usage.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { P43_TURNS } from '../economy/price/__fixtures__/p43-turns.ts';
import { CREATED, deps, fakeClock, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';
import { priceBookOf, taskViewOf } from './task-view.ts';

/**
 * Вид задачи для панели (этап 9): расход — тем же `spendOf`, что и золотой P43 (аналитика панели
 * над теми же ходами, `economy/price/price.test.ts`), проверки ленты — из решений `check` с их
 * записями, ответ `GET /v1/tasks/:id` проходит строгую схему контракта.
 */

const MONEY: Fact<RoutePrice> = { value: { unit: 'money', source: 'anthropic' } };
/** Числа аналитики панели над `P43_TURNS` (снимок 30.10.2026, `price.test.ts` PANEL_GOLDEN). */
const P43_USD = 0.26595;

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function p43Task(): Promise<{ task: LiveTask; sessionId: string; stepId: string }> {
  const ordered = [...P43_TURNS].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let wall = Date.parse(ordered[0]!.at);
  const clock = fakeClock(wall);
  const task = await createTaskRegistry(tempDir('view-p43-'), deps({ clock })).create(CREATED);
  const { sessionId, stepId } = seedSession(task, { stepKind: 'work' });
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  for (const t of ordered) {
    clock.advance(Date.parse(t.at) - wall);
    wall = Date.parse(t.at);
    journalUsage(task, got.binding, { type: 'usage', ...t });
  }
  return { task, sessionId, stepId };
}

function checkDecision(task: LiveTask, stepId: string, output: Record<string, unknown>): string {
  const decisionId = newId();
  task.append({
    kind: 'decision',
    actor: 'core',
    stepId,
    data: {
      decisionId,
      class: 'check',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: ['test'],
      output: output as never,
    },
  });
  return decisionId;
}

function requested(task: LiveTask, stepId: string): string {
  const checkRunId = newId();
  task.append({
    kind: 'check.requested',
    actor: 'core',
    stepId,
    data: {
      checkRunId,
      checkId: 'unit',
      unit: 'u1',
      key: null,
      grade: 'unit',
      origin: 'core',
      road: 'conductor',
      stepId,
    },
  });
  return checkRunId;
}

describe('task view for the panel (stage 9)', () => {
  it('P43 spend in the view equals the panel golden: total, per session and per step, through spendOf', async () => {
    const { task, sessionId, stepId } = await p43Task();
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const view = taskViewOf({
      taskId: task.taskId,
      state: task.state,
      lines,
      priceFor: await priceBookOf(lines, async () => MONEY),
      attention: null,
    });
    expect(taskViewSchema.parse(view)).toEqual(view);
    expect(view.spend.cost.usd).toBeCloseTo(P43_USD, 12);
    expect(view.spend.cost.turns).toBe(5);
    expect(view.spend.bySession[sessionId]!.cost.usd).toBeCloseTo(P43_USD, 12);
    expect(view.spend.byStep[stepId]!.cost.usd).toBeCloseTo(P43_USD, 12);
    expect(view.spend.tokens).toEqual({
      input: 7740,
      output: 4600,
      cacheRead: 150_000,
      cacheWrite: 19_000,
      cacheWrite1h: 8000,
      turns: 5,
    });
    expect(view.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        stepId,
        cli: 'claude',
        cliVersion: '1',
        route: { kind: 'stub', id: 'stub-1' },
        modelAsked: 'model-a',
        effort: null,
      }),
    ]);
    expect(view.steps.map((s) => [s.stepId, s.stepKind, s.state])).toEqual([
      [stepId, 'work', 'running'],
    ]);
  });

  it('no route price port: turns stay tokens without a price, never money by guess (P127)', async () => {
    const { task } = await p43Task();
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const view = taskViewOf({
      taskId: task.taskId,
      state: task.state,
      lines,
      priceFor: await priceBookOf(lines, undefined),
      attention: 'journal did not open',
    });
    expect(view.spend.cost.usd).toBe(0);
    expect(view.spend.cost.unpricedTokens).toBeGreaterThan(0);
    expect(view.attention).toBe('journal did not open');
  });

  it('checks: run/narrow take the record of their own requested run, replay names its record, other kinds are not checks', async () => {
    const { task, stepId } = await p43Task();
    const run = checkDecision(task, stepId, {
      kind: 'run',
      grade: 'unit',
      selection: [],
      reason: 'tree changed',
    });
    const runId = requested(task, stepId);
    task.append({
      kind: 'check.recorded',
      actor: 'core',
      stepId,
      data: { checkRunId: runId, recordId: 'rec-run' },
    });
    const replay = checkDecision(task, stepId, {
      kind: 'replay',
      recordId: 'rec-old',
      header: 'same key',
    });
    checkDecision(task, stepId, { kind: 'wait', checkRunId: runId, deadlineMs: 1 });
    const narrow = checkDecision(task, stepId, {
      kind: 'narrow',
      units: ['u1'],
      selection: [],
      reason: 'one unit',
    });
    requested(task, stepId);
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const view = taskViewOf({
      taskId: task.taskId,
      state: task.state,
      lines,
      priceFor: () => MONEY,
      attention: null,
    });
    expect(view.checks.map((c) => [c.decisionId, c.mode, c.why, c.recordId])).toEqual([
      [run, 'run', 'tree changed', 'rec-run'],
      [replay, 'replay', 'same key', 'rec-old'],
      [narrow, 'narrow', 'one unit', null],
    ]);
  });

  it('GET /v1/tasks/:id carries a view the strict contract accepts; stage-9 reads answer typed codes behind the read token', async () => {
    stand = await startStand();
    const res = await stand.get(`/v1/tasks/${stand.taskId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: unknown; live: boolean };
    const view = taskViewSchema.parse(body.view);
    expect(view.taskId).toBe(stand.taskId);
    expect(view.spend.cost.turns).toBe(0);
    // Заглушки волны 0 заменены чтениями (зона D): у стенда нет реестра маршрутов, профиля,
    // задачи у записи и отчёта — каждый ответ свой типизированный, а не общий 501.
    for (const [path, status, code] of [
      ['/v1/routes', 501, 'not-implemented'],
      ['/v1/profiles/r1', 404, 'no-profile'],
      [`/v1/records/${newId()}`, 400, 'bad-id'],
      [`/v1/tasks/${stand.taskId}/report`, 404, 'no-report'],
    ] as const) {
      const read = await stand.get(path);
      expect({
        path,
        status: read.status,
        code: ((await read.json()) as { code: string }).code,
      }).toEqual({ path, status, code });
      expect((await stand.get(path, '')).status, path).toBe(401);
      expect((await stand.get(path, TOKENS.session)).status, path).toBe(401);
    }
  });
});

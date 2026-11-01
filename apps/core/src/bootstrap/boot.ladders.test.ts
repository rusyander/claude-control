import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../adapters/index.ts';
import { liveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { decideRouting } from '../conductor/scenario/index.ts';
import {
  CREATED,
  MINI_SCENARIO,
  SOLO_UNIT,
  tempDir,
} from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { decidePermit } from '../policy/permit/permit.ts';
import { loginRoute, roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Лестницы моделей на НАСТОЯЩЕЙ загрузке (дефект закрытия этапа 7): лестница каждого переходника
 * строится из фактов запуска CLI (`@agentdeck/providers`, `modelRungs` + `effort.values`) и
 * доходит до всех трёх судов, которые без неё молчали в продукте:
 * - суд `tier` шага (`routingEnv` экономики загрузки): понижение механики и подъём усилия плана;
 * - предупреждение `set-model` «ревьюер ниже автора» через API ядра (`CommandEnv.modelRank`);
 * - потолок подагента в контексте права дороги сессии (`layer-facts`), алиас и полный id — одна
 *   ступень. Подменённого нет: реестр переходников, экономика, API и дорога — те, что у продукта.
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

async function boot(): Promise<BootedCore> {
  const core = await bootCore({
    home: join(tempDir('ladders-core-'), 'core'),
    build: 'ladders-test',
    loop: false,
  });
  booted.push(core);
  return core;
}

const CLAUDE = claudeRunFacts.id;

async function taskOn(core: BootedCore, modelCeiling: string | null): Promise<LiveTask> {
  return core.registry.create({
    ...CREATED,
    modelCeiling,
    allowedRoutes: [
      { adapter: CLAUDE, route: { kind: 'cli-login', id: loginRoute(CLAUDE) }, modelPattern: '*' },
    ],
  });
}

const stepDef = (kind: string, tier: StepDef['model']['tier']): StepDef =>
  ({ ...MINI_SCENARIO.steps[0]!, id: kind, kind, model: { tier } }) as StepDef;

function tierOf(core: BootedCore, task: LiveTask, def: StepDef) {
  return decideRouting(
    task.state,
    { stepId: null, unitId: null, def },
    core.economy.routingEnv!(task),
  ).tier;
}

describe('boot: provider ladders reach the tier judge, set-model and the subagent ceiling', () => {
  it('tier: a mechanical step on the claude route is lowered one rung below the ceiling (alias or full id), a plan step raised to xhigh, never max', async () => {
    const core = await boot();
    for (const ceiling of ['opus', 'claude-opus-5-5']) {
      const task = await taskOn(core, ceiling);
      const low = tierOf(core, task, stepDef('work', 'lower-if-mechanical'));
      expect(low.ok, low.reasons.join('; ')).toBe(true);
      expect(low).toMatchObject({ model: 'sonnet', applied: 'lowered' });
      expect(low.reasons.join('\n')).toContain('model lowered to sonnet');
      const plan = tierOf(core, task, stepDef('plan', 'raise-for-planning'));
      expect(plan).toMatchObject({ ok: true, model: ceiling, effort: 'xhigh', applied: 'raised' });
    }
    // Нижняя ступень ниже не опускается: haiku остаётся на потолке и называет причину.
    const floor = tierOf(core, await taskOn(core, 'haiku'), stepDef('work', 'lower-if-mechanical'));
    expect(floor).toMatchObject({ ok: true, model: 'haiku', applied: 'ceiling' });
    expect(floor.reasons.join('\n')).toContain('no lower rung on the ladder');
  });

  it('set-model through the core API: a reviewer set below its author warns once by the claude ladder; above the author — no warning', async () => {
    const core = await boot();
    const task = await taskOn(core, 'opus');
    const unitId = newId();
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: { unitId, repoKey: 'r1', branch: 'b', ownedPaths: [], ...SOLO_UNIT },
    });
    const step = (stepKind: 'work' | 'review'): string => {
      const stepId = newId();
      task.append({
        kind: 'step.started',
        actor: 'core',
        unitId,
        stepId,
        data: {
          stepId,
          unitId,
          stepKind,
          stepDefId: stepKind,
          round: 0,
          scenario: CREATED.scenario,
          budgetMs: 0,
        },
      });
      return stepId;
    };
    const author = step('work');
    const review = step('review');
    const below = await setModel(core, task.taskId, review, 'sonnet');
    expect(below.status, JSON.stringify(below.body)).toBe(200);
    expect(below.body.outcome?.warnings).toEqual([
      `review step ${review} (${CLAUDE}/sonnet) vs its author step ${author} (${CLAUDE}/opus): the reviewer model ranks below the author model`,
    ]);
    // Полное имя старшей ступени — ранг выше автора: правка без предупреждения.
    const above = await setModel(core, task.taskId, review, 'claude-fable-5');
    expect(above.status, JSON.stringify(above.body)).toBe(200);
    expect(above.body.outcome).not.toHaveProperty('warnings');
  });

  it('subagent ceiling on the session road: a named model above the task ceiling is denied, at or below it (alias or full id) allowed, an unranked one refused as unknown', async () => {
    const core = await boot();
    const live = liveRoot('ladders-road-');
    const ctxOf = async (ceiling: string | null, sessionModel: string) => {
      const task = await taskOn(core, ceiling);
      const start = roadStart({
        live,
        bin: join(live.root, 'bin'),
        task,
        adapterId: CLAUDE,
        fixture: join(live.root, 'none.jsonl'),
        dump: join(live.root, 'dump.json'),
      });
      return core.road.contextFor({ ...start, model: sessionModel });
    };
    const verdict = (ctx: Awaited<ReturnType<typeof ctxOf>>, model: string) =>
      decidePermit(agent('helper', model), ctx, 'work');

    const ctx = await ctxOf('opus', 'stub-model');
    expect(verdict(ctx, 'fable')).toMatchObject({ allow: false, code: 'model-above-ceiling' });
    expect(verdict(ctx, 'claude-fable-5-1')).toMatchObject({
      allow: false,
      code: 'model-above-ceiling',
    });
    for (const model of ['opus', 'claude-opus-5-5', 'sonnet', 'claude-haiku-4-5'])
      expect(verdict(ctx, model), model).toMatchObject({ allow: true });
    expect(verdict(ctx, 'gpt-codex-9')).toMatchObject({
      allow: false,
      code: 'subagent-model-unknown',
    });
    // Потолка задачи нет — потолок = модель шага (R8), полным именем.
    const bySession = await ctxOf(null, 'claude-sonnet-5');
    expect(verdict(bySession, 'opus')).toMatchObject({ allow: false, code: 'model-above-ceiling' });
    expect(verdict(bySession, 'haiku')).toMatchObject({ allow: true });
  });
});

const agent = (target: string, model: string): PermissionAsk => ({
  action: 'subagent',
  target,
  model,
  tool: 'Agent',
  display: `Agent ${target}`,
});

async function setModel(
  core: BootedCore,
  taskId: string,
  stepId: string,
  model: string,
): Promise<{ status: number; body: { outcome?: { warnings?: string[] } } }> {
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/commands`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      kind: 'set-model',
      target: { taskId },
      fields: { scope: 'step', scopeId: stepId, model, effort: 'high', timing: 'safe-point' },
      proof: { nonce, page },
    }),
  });
  return { status: res.status, body: (await res.json()) as { outcome?: { warnings?: string[] } } };
}

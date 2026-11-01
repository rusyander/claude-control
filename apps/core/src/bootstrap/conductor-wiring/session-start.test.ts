import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { decideRouting } from '../../conductor/scenario/index.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import { CREATED, openFresh, SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { LEASE_SIGNAL } from '../session-road/lease-release.ts';
import {
  journaledLease,
  journaledSessionDir,
  processPin,
  sessionDirOf,
  STEP_DENY,
  stepStart,
} from './session-start.ts';

/**
 * Запуск сессии шага в продукте (зона B) из фактов журнала: маршрут — суд `tier`, копия — строка
 * копии крючка F, аренда — живая строка `route-lease`, каталог — цель `process-start`.
 */

const ROUTE = { adapter: 'claude', route: { kind: 'cli-login' as const, id: 'cli-login:claude' } };

async function taskWith(
  opts: { ceiling?: string | null; pattern?: string; extraRoute?: string } = {},
) {
  const { task } = await openFresh();
  const extra = opts.extraRoute
    ? [
        {
          adapter: 'claude',
          route: { kind: 'stub' as const, id: opts.extraRoute },
          modelPattern: '*',
        },
      ]
    : [];
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      modelCeiling: opts.ceiling === undefined ? 'sonnet' : opts.ceiling,
      allowedRoutes: [{ ...ROUTE, modelPattern: opts.pattern ?? '*' }, ...extra],
    },
  });
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: 'agentdeck/u',
      ownedPaths: ['src/a'],
      ...SOLO_UNIT,
    },
  });
  return { task, unitId };
}

function placeCopy(task: LiveTask, unitId: string, worktree: string, repo: string): string {
  const rid = newId();
  task.append({
    kind: 'resource.created',
    actor: 'core',
    unitId,
    data: {
      rid,
      kind: 'copy',
      owner: 'core',
      release: 'task-end',
      ref: JSON.stringify({ worktree, repo }),
    },
  });
  return rid;
}

function ctx(task: LiveTask, unitId: string, def: StepDef, copyDir: string | null = null): StepCtx {
  const stepId = newId();
  return {
    taskId: task.taskId,
    unitId,
    repoKey: 'r1',
    copyDir,
    stepId,
    def,
    round: 0,
    sessionId: null,
    routing: decideRouting(task.state, { stepId, unitId, def }),
  };
}

const WORK = presetStep('work', 'work', 'Работа', []);
const INTAKE = presetStep('intake', 'intake', 'Разбор', []);
const PIN = { HOME: '/h' };

describe('product session start from journal facts', () => {
  it('copy laid by the copy hook → cwd, sourceRepo, owned paths, session dir beside the journal, model by tier, tools by step kind', async () => {
    const { task, unitId } = await taskWith();
    placeCopy(task, unitId, '/copies/u', '/repos/src');
    const s = ctx(task, unitId, WORK);
    const got = stepStart({ task, pin: PIN, pathPrefix: ['/bin'] }, s, 'sess-1');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.start).toMatchObject({
      stepId: s.stepId,
      stepKind: 'work',
      adapterId: 'claude',
      routeId: 'cli-login:claude',
      model: 'sonnet',
      sessionId: 'sess-1',
      dir: join(task.dir, 'sessions', 'sess-1'),
      cwd: '/copies/u',
      sourceRepo: '/repos/src',
      ownedPaths: ['src/a'],
      tools: 'all',
      deny: STEP_DENY,
      layer: { hooks: WORK.userLayer.hooks },
      pin: PIN,
      pathPrefix: ['/bin'],
    });
    expect(got.start.brief).toContain(`agentdeck-step: ${s.stepId}`);
    expect(got.start.brief).toContain('agentdeck-copy: /copies/u');
    expect(got.start.lease).toBeUndefined();
    const intake = stepStart({ task, pin: PIN }, ctx(task, unitId, INTAKE), 'sess-2');
    expect(intake.ok && intake.start.tools).toBe('read-only');
  });

  it('refusals before any process: no routing, tier refused, no copy; the CLI-default model starts with model null', async () => {
    const { task, unitId } = await taskWith();
    placeCopy(task, unitId, '/copies/u', '/repos/src');
    const bare = { ...ctx(task, unitId, WORK) };
    delete bare.routing;
    expect(stepStart({ task, pin: PIN }, bare, 's')).toEqual({
      ok: false,
      reason: 'step has no routing decision',
    });
    const refused = ctx(task, unitId, WORK);
    refused.routing = {
      tier: {
        ok: false,
        reasons: ['no allowed route'],
        dropped: [],
        skipped: [],
        alternatives: [],
        numbers: {},
        basis: 'modelled',
      },
      continuation: null,
    };
    expect(stepStart({ task, pin: PIN }, refused, 's')).toEqual({
      ok: false,
      reason: 'tier refused: no allowed route',
    });

    // Модель по умолчанию CLI (оценка без потолка) — не отказ: `model: null`, аренды нет.
    const free = await taskWith({ ceiling: null });
    placeCopy(free.task, free.unitId, '/c', '/r');
    const dflt = stepStart({ task: free.task, pin: PIN }, ctx(free.task, free.unitId, WORK), 's');
    expect(dflt.ok).toBe(true);
    expect(dflt.ok && dflt.start.model).toBeNull();
    expect(dflt.ok && 'lease' in dflt.start).toBe(false);

    const bareCopy = await taskWith();
    const none = stepStart(
      { task: bareCopy.task, pin: PIN },
      ctx(bareCopy.task, bareCopy.unitId, WORK),
      's',
    );
    expect(none).toEqual({ ok: false, reason: `unit ${bareCopy.unitId} has no copy` });
    // Копия, известная исполнителю (`copyDirOf`), годится и без строки ресурса.
    const known = stepStart(
      { task: bareCopy.task, pin: PIN },
      ctx(bareCopy.task, bareCopy.unitId, WORK, '/known'),
      's',
    );
    expect(known.ok && known.start.cwd).toBe('/known');
  });

  it('a live route lease of the same route and model is reused after a restart; released, empty or other-model leases are not', async () => {
    const { task, unitId } = await taskWith();
    placeCopy(task, unitId, '/c', '/r');
    const lease = (model: string, rids: string[]): string => {
      const leaseId = newId();
      task.append({
        kind: 'signal',
        actor: 'core',
        data: {
          signal: LEASE_SIGNAL,
          severity: 'info',
          subject: leaseId,
          detail: JSON.stringify({ routeId: 'cli-login:claude', model, rids }),
        },
      });
      return leaseId;
    };
    const server = (): string => {
      const rid = newId();
      task.append({
        kind: 'resource.created',
        actor: 'core',
        data: { rid, kind: 'stub-server', owner: 'core', release: 'task-end', ref: '{"pid":1}' },
      });
      return rid;
    };
    lease('sonnet', []);
    expect(journaledLease(task, 'cli-login:claude', 'sonnet')).toBeUndefined();
    const rid = server();
    const kept = lease('sonnet', [rid]);
    lease('opus', [server()]);
    expect(journaledLease(task, 'cli-login:claude', 'sonnet')?.leaseId).toBe(kept);
    expect(journaledLease(task, 'other-route', 'sonnet')).toBeUndefined();
    const got = stepStart({ task, pin: PIN }, ctx(task, unitId, WORK), 's');
    expect(got.ok && got.start.lease?.leaseId).toBe(kept);
    task.append({ kind: 'resource.released', actor: 'core', data: { rid } });
    expect(journaledLease(task, 'cli-login:claude', 'sonnet')).toBeUndefined();
  });

  it('session dir: the process-start target the journal names, else the rule beside the journal', async () => {
    const { task } = await taskWith();
    const sessionId = newId();
    expect(journaledSessionDir(task, sessionId)).toBe(sessionDirOf(task, sessionId));
    const target = join('/elsewhere', 'sessions', sessionId);
    task.append({
      kind: 'action.started',
      actor: 'core',
      data: { actionId: newId(), kind: 'process-start', target, idempotencyHint: 'x' },
    });
    expect(journaledSessionDir(task, sessionId)).toBe(target);
  });

  it('process pin keeps only what the CLI needs to find its home and login', () => {
    const pin = processPin({ HOME: '/h', PATH: '/p', SECRET_TOKEN: 'x', CLAUDE_CONFIG_DIR: '/c' });
    expect(pin).toEqual({ HOME: '/h', PATH: '/p', CLAUDE_CONFIG_DIR: '/c' });
  });
});

/** Строка запуска сессии `adapter`; `resumeOf` — продолжение разговора прежней сессии ядра. */
function started(task: LiveTask, adapter: string, resumeOf: string | null = null): string {
  const sessionId = newId();
  const stepId = newId();
  task.append({
    kind: 'session.started',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      sessionId,
      stepId,
      adapter,
      cliVersion: '1',
      route: ROUTE.route,
      hops: [],
      credentialKind: 'none',
      modelAsked: null,
      modelServed: null,
      effort: null,
      hostPid: process.pid,
      hostStart: `start-${process.pid}`,
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf,
      cacheAgeMs: null,
    },
  } as never);
  return sessionId;
}

function sameSession(s: StepCtx, sessionId: string): StepCtx {
  const numbers = { cacheAgeMs: 4000 } as never;
  return {
    ...s,
    routing: {
      ...s.routing!,
      continuation: { mode: 'same-session', sessionId, reasons: [], numbers, basis: 'modelled' },
    },
  };
}

describe('continuation decision → road resume (stage 5 W, 03:150-155)', () => {
  it('same-session resumes the conversation ROOT of the prior session and names it in resumeOf; fresh starts new', async () => {
    const { task, unitId } = await taskWith();
    placeCopy(task, unitId, '/copies/u', '/repos/src');
    const root = started(task, 'claude');
    const second = started(task, 'claude', root);
    const s = ctx(task, unitId, WORK);
    const got = stepStart({ task, pin: PIN }, sameSession(s, second), 'sess-3');
    expect(got.ok && got.start.resume).toEqual({
      conversationId: root,
      of: second,
      cacheAgeMs: 4000,
    });
    const fresh = stepStart({ task, pin: PIN }, s, 'sess-4');
    expect(fresh.ok && fresh.start.resume).toBeUndefined();
  });

  it('P110 the tier alternatives travel to the road as candidate triples with the step model', async () => {
    const { task, unitId } = await taskWith({ extraRoute: 'stub:alt' });
    placeCopy(task, unitId, '/copies/u', '/repos/src');
    const s = ctx(task, unitId, WORK);
    const tier = s.routing!.tier;
    expect(tier.ok && tier.alternatives.length).toBe(1);
    const got = stepStart({ task, pin: PIN }, s, 's');
    if (!got.ok || !tier.ok) throw new Error('no start');
    const other = tier.route.id === 'stub:alt' ? 'cli-login:claude' : 'stub:alt';
    expect(got.start.alternatives).toEqual([
      { adapterId: 'claude', routeId: other, model: tier.model },
    ]);
  });

  it('a prior session of another CLI is never resumed: the new session starts fresh', async () => {
    const { task, unitId } = await taskWith();
    placeCopy(task, unitId, '/copies/u', '/repos/src');
    const other = started(task, 'qwen');
    const got = stepStart({ task, pin: PIN }, sameSession(ctx(task, unitId, WORK), other), 's');
    expect(got.ok && got.start.resume).toBeUndefined();
  });
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { presetOf, presetStep } from '../conductor/scenario/presets.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { startSessionStand, type SessionStand } from '../mcp/__fixtures__/session-stand.ts';
import {
  createSessionStatePort,
  launchSnapshot,
  libraryScenarioOf,
  stepDefOf,
} from './session-state.ts';
import type { RoadStart } from './session-road/road.types.ts';

/**
 * G8 — `GET /v1/session/state` отдаёт документ СВОЕЙ сессии токена (ядро — правда), дорога
 * получает тот же документ снимком (`source: 'snapshot'`). Сценарий шага — пресет или версия
 * библиотеки человека, прочитанная синхронно; не найден — 500 с причиной, не пустой документ.
 */

let stand: SessionStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const get = (s: SessionStand, token: string) =>
  fetch(`${s.url}/v1/session/state`, { headers: { authorization: `Bearer ${token}` } });

const FEATURE = presetOf({ id: 'feature', version: 1 });

/** Библиотека человека с `default@1` (сценарий задачи стенда) — копия пресета `feature`. */
function libraryWithDefault(): string {
  if (!FEATURE) throw new Error('preset feature@1 missing');
  const dir = tempDir('scen-');
  writeFileSync(join(dir, 'default@1.json'), JSON.stringify({ ...FEATURE, id: 'default' }));
  return dir;
}

describe('G8 session state port (bootstrap/session-state)', () => {
  it('a session token reads the doc of its own session only; another session token reads its own step', async () => {
    const scenarioOf = libraryScenarioOf(libraryWithDefault());
    stand = await startSessionStand({ state: createSessionStatePort({ scenarioOf }) });
    const res = await get(stand, stand.sessionToken);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as SessionStateDoc;
    expect(doc).toMatchObject({
      v: 1,
      source: 'core',
      task: stand.task.taskId,
      step: { id: stand.session.stepId, kind: 'work', defId: 'work', title: 'Работа' },
      layer: { hooks: 'on', skills: 'on' },
    });
    expect(JSON.stringify(doc)).not.toContain(stand.sessionToken);
    const second = seedSession(stand.task, { stepKind: 'work' });
    const token = stand.tokens.mint({ taskId: stand.task.taskId, sessionId: second.sessionId });
    const other = (await (await get(stand, token)).json()) as SessionStateDoc;
    expect(other.step.id).toBe(second.stepId);
    expect(other.step.id).not.toBe(doc.step.id);
  });

  it('a step whose scenario cannot be found answers 500 state-unreadable naming the definition', async () => {
    stand = await startSessionStand({
      state: createSessionStatePort({ scenarioOf: () => undefined }),
    });
    const res = await get(stand, stand.sessionToken);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: 'state-unreadable',
      error: expect.stringContaining('step definition work not found'),
    });
  });

  it('the launch snapshot is the same doc with source snapshot; unknown step → undefined (launch writes incomplete)', async () => {
    const scenarioOf = libraryScenarioOf(libraryWithDefault());
    stand = await startSessionStand();
    const snap = launchSnapshot({ scenarioOf });
    const start = { stepId: stand.session.stepId } as RoadStart;
    const doc = snap(stand.task, start);
    const core = createSessionStatePort({ scenarioOf }).read(stand.task, {
      taskId: stand.task.taskId,
      sessionId: stand.session.sessionId,
      stepId: stand.session.stepId,
      unitId: stand.session.unitId,
      stepKind: 'work',
    });
    if (!('value' in core)) throw new Error(core.unknown);
    expect(doc).toEqual({ ...core.value, source: 'snapshot' });
    expect(snap(stand.task, { stepId: 'nope' } as RoadStart)).toBeUndefined();
  });

  it('a library version is read from <home>/scenarios, kept once read; a file naming another version is not taken', () => {
    const dir = tempDir('scen-');
    const base = FEATURE;
    if (!base) throw new Error('preset feature@1 missing');
    const mine = {
      ...base,
      id: 'mine',
      version: 3,
      steps: base.steps.map((s) =>
        s.id === 'work'
          ? {
              ...presetStep('work', 'work', 'Моя работа', s.after),
              userLayer: { hooks: 'off', skills: 'off' },
            }
          : s,
      ),
    };
    writeFileSync(join(dir, 'mine@3.json'), JSON.stringify(mine));
    writeFileSync(join(dir, 'mine@4.json'), JSON.stringify(mine));
    const scenarioOf = libraryScenarioOf(dir);
    expect(scenarioOf({ id: 'mine', version: 3 })?.steps.find((s) => s.id === 'work')?.title).toBe(
      'Моя работа',
    );
    expect(scenarioOf({ id: 'mine', version: 4 })).toBeUndefined();
    expect(scenarioOf({ id: 'absent', version: 1 })).toBeUndefined();
    // Версия пишется один раз (G11): прочитанная не перечитывается.
    writeFileSync(join(dir, 'mine@3.json'), '{broken');
    expect(scenarioOf({ id: 'mine', version: 3 })?.id).toBe('mine');
    const state = {
      steps: { s1: { stepDefId: 'work' } },
      scenario: { ref: { id: 'mine', version: 3 }, pending: null, rejected: 0 },
      created: { scenario: { id: 'default', version: 1 } },
    } as never;
    expect(stepDefOf(state, 's1', scenarioOf)?.userLayer).toEqual({ hooks: 'off', skills: 'off' });
  });
});

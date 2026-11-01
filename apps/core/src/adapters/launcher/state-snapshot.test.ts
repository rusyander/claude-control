import { SESSION_STATE_V, type SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import type { CoreSessionVars } from './launcher.types.ts';
import { stateSnapshot } from './state-snapshot.ts';

/**
 * G8 — `state.json` сессии: документ дороги целиком с `source: 'snapshot'`; поля запуска поверх
 * не кладутся (объект шага не затирается его id). Нет документа или он о чужом шаге — неполный
 * снимок с причиной. Токена сессии в снимке нет.
 */

const DOC: SessionStateDoc = {
  v: SESSION_STATE_V,
  source: 'core',
  asOf: 3,
  task: 't-1',
  step: { id: 's-1', kind: 'work', title: 'Work', defId: 'work' },
  requirements: [],
  ownedPaths: [],
  requiredChecks: [],
  budgets: { tokens: { spent: 0, limit: null }, minutes: { spent: 0, limit: null } },
  ciWait: false,
  layer: { hooks: 'on', skills: 'on' },
};

const core = (state?: SessionStateDoc): CoreSessionVars => ({
  taskId: 't-1',
  stepId: 's-1',
  stepKind: 'work',
  coreUrl: 'http://127.0.0.1:1',
  sessionToken: 'secret-session-token',
  ...(state ? { state } : {}),
});

describe('G8 launch state snapshot (adapters/launcher)', () => {
  it('the road doc lands whole with source snapshot — the step stays an object, never the step id', () => {
    const snap = stateSnapshot(core(DOC));
    expect(snap).toEqual({ ...DOC, source: 'snapshot' });
    expect(JSON.stringify(snap)).not.toContain('secret-session-token');
  });

  it('no doc, or a doc of another task/step → incomplete snapshot naming why, with task and step id', () => {
    expect(stateSnapshot(core())).toEqual({
      v: SESSION_STATE_V,
      source: 'snapshot',
      task: 't-1',
      step: { id: 's-1', kind: 'work' },
      incomplete: 'state document not supplied at launch',
    });
    const foreign = stateSnapshot(core({ ...DOC, step: { ...DOC.step, id: 's-9' } }));
    expect(foreign).toMatchObject({ incomplete: expect.stringContaining('t-1/s-9') });
  });
});

import { SESSION_STATE_V, type SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import { afterEach, describe, expect, it } from 'vitest';
import { startSessionStand, type SessionStand } from '../mcp/__fixtures__/session-stand.ts';
import type { SessionStatePort } from './session-state.types.ts';

/**
 * Шов `GET /v1/session/state` (этап 7, волна 0): ручку держит API ручек сессии, документ — зона
 * состояния. Сессию называет НАСТОЯЩИЙ токен сессии (HMAC от токена ядра); без порта — 501,
 * порт не прочитал — 500 с причиной, а не пустой документ.
 */

let stand: SessionStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const state = (s: SessionStand, token?: string) =>
  fetch(`${s.url}/v1/session/state`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

function docOf(task: string, stepId: string): SessionStateDoc {
  return {
    v: SESSION_STATE_V,
    source: 'core',
    asOf: 1,
    task,
    step: { id: stepId, kind: 'work', title: 'шаг', defId: 'work' },
    requirements: [],
    ownedPaths: [],
    requiredChecks: [],
    budgets: { tokens: { spent: 0, limit: null }, minutes: { spent: 0, limit: null } },
    ciWait: false,
    layer: { hooks: 'off', skills: 'off' },
  };
}

describe('session state route seam', () => {
  it('without a state port a session token gets 501; no token is 401 before the port is asked', async () => {
    stand = await startSessionStand();
    expect((await state(stand)).status).toBe(401);
    const res = await state(stand, stand.sessionToken);
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([
      501,
      'not-implemented',
    ]);
  });

  it('with a port: the doc of the token own session is returned; an unreadable doc is 500, not empty', async () => {
    const asked: string[] = [];
    let unreadable = false;
    const port: SessionStatePort = {
      read(task, binding) {
        asked.push(binding.sessionId);
        return unreadable
          ? { unknown: 'journal unreadable' }
          : { value: docOf(task.taskId, binding.stepId) };
      },
    };
    stand = await startSessionStand({ state: port });
    const ok = await state(stand, stand.sessionToken);
    expect([ok.status, await ok.json()]).toEqual([
      200,
      docOf(stand.task.taskId, stand.session.stepId),
    ]);
    unreadable = true;
    const broken = await state(stand, stand.sessionToken);
    expect([broken.status, ((await broken.json()) as { code: string }).code]).toEqual([
      500,
      'state-unreadable',
    ]);
    expect(asked).toEqual([stand.session.sessionId, stand.session.sessionId]);
  });
});

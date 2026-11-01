import { describe, expect, it } from 'vitest';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { newId } from '../../lib/ids/uuidv7.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { applySetRoute } from '../commands/set-route.ts';
import { presetStep } from '../scenario/presets.ts';
import { ROUTE, stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * P119 на цикле дирижёра (08b, стадия 5): маршрут сессии закреплён — смена набора маршрутов
 * командой `set-route` между кругами шага даёт НОВЫЙ сеанс на новом маршруте, а не продолжение
 * прежнего разговора: суд продолжения называет причину `route-changed` и кэш холодным.
 * Цикл настоящий (`runTask`), команда — настоящий применитель; сессии — порт стенда.
 */

const OWN = {
  adapter: 'claude',
  route: { kind: 'api-key' as const, id: 'api-key:endpoint:own' },
  modelPattern: '*',
};

const ONE_WORK: Scenario = {
  id: 'route-change',
  version: 1,
  title: 't',
  steps: [presetStep('work', 'work', 'Работа', [])],
};

/** `set-route` настоящим применителем: реестр стенда знает оба маршрута. */
async function setRoute(s: Stand): Promise<void> {
  const cmdId = newId();
  const fields = { scope: 'task', scopeId: s.taskId, allowedRoutes: [OWN] };
  s.task.append({
    kind: 'command.received',
    actor: 'human:panel',
    cmdId,
    data: {
      kind: 'set-route',
      target: { taskId: s.taskId },
      expectSeq: null,
      fields,
      proof: { token: 'core', nonce: 'absent', peer: 'clear', signature: 'absent' },
    } as never,
  });
  const kinds: Record<string, 'cli-login' | 'api-key'> = {
    [ROUTE.route.id]: 'cli-login',
    [OWN.route.id]: 'api-key',
  };
  const envelope = {
    cmdId,
    kind: 'set-route',
    target: { taskId: s.taskId },
    expectSeq: null,
    fields,
  };
  await applySetRoute(s.task, envelope as unknown as CommandEnvelope, {
    ...commandEnv(),
    routes: () => ({ routeOf: (id) => (kinds[id] ? { kind: kinds[id] } : undefined) }),
  });
}

describe('P119 on the conductor loop: a route change starts a new session', () => {
  it('set-route between rounds → the retry opens a fresh session on the new route; continuation says route-changed, cache cold', async () => {
    let changed = false;
    // Стенд нужен крючку раньше, чем `stand` вернёт его: ссылка заполняется сразу после.
    const ref: { stand?: Stand } = {};
    // Круг 0 молчит и кончается без исхода; до повтора человек меняет маршрут командой.
    // Транскрипт прежней сессии на месте: её можно было бы продолжить `--resume` — новый сеанс
    // назначает именно смена маршрута, а не отсутствие живой сессии.
    const economy = {
      windows: () => [],
      routingEnv: () => ({ continuation: () => ({ transcriptPresent: true }) }),
    };
    const script = { model: { 'work:0': 'silent' as const }, journalSessions: true, economy };
    const s = await stand(ONE_WORK, script, [
      {
        postStep: async (step) => {
          if (step.def.id === 'work' && step.round === 0 && !changed && ref.stand) {
            changed = true;
            await setRoute(ref.stand);
          }
          return { verdict: { ok: true }, facts: {} };
        },
      },
    ]);
    ref.stand = s;
    await s.run.idle();
    expect(changed).toBe(true);
    const work = s.port.opened.filter((o) => o.def.id === 'work');
    expect(work.map((o) => o.round)).toEqual([0, 1]);
    const tiers = work.map((o) => (o.routing?.tier.ok ? o.routing.tier.route.id : null));
    expect(tiers).toEqual([ROUTE.route.id, OWN.route.id]);
    expect(work[1]!.routing?.continuation).toMatchObject({
      mode: 'fresh',
      reason: 'route-changed',
      numbers: { cacheWarm: false },
    });
    // Два разных сеанса в свёртке: второй — на новом маршруте, не `resumeOf` первого.
    const sessions = Object.values(s.task.state.sessions).filter((x) => x.route?.id);
    expect(sessions.map((x) => x.route!.id)).toEqual([ROUTE.route.id, OWN.route.id]);
    expect(new Set(Object.keys(s.task.state.sessions)).size).toBe(2);
    await s.stop();
  });
});

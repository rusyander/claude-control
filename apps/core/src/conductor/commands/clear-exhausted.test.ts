import type { HopControlReply } from '@agentdeck/contracts/core/hops';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveTask } from '../../journal/resume.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import {
  API_KEY,
  envelope,
  homeTask,
  HUMAN_PROOF,
  LOGIN,
} from '../scenario/__fixtures__/scenario-harness.ts';
import type { ClearExhaustedPort, CommandEnv } from './commands.types.ts';

/**
 * P122/G11: исчерпание (402) снимает только человек командой `clear-exhausted` через порт
 * управления звеном (подставной порт — клиент `routes/hops` зоны H). Звено не ответило или
 * отказало — честный отказ, не «снято».
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

async function send(port: ClearExhaustedPort | undefined, routeId = API_KEY.route.id) {
  const { task: t } = await homeTask({ allowedRoutes: [LOGIN, API_KEY] });
  open.push(t);
  const env: CommandEnv = { ...commandEnv(), hops: () => port };
  return processCommand(t, envelope(t, 'clear-exhausted', { routeId }), HUMAN_PROOF, env);
}

describe('clear-exhausted (P122)', () => {
  it('goes to the hop once with the route id; the cleared answer is the applied outcome', async () => {
    const asked: unknown[] = [];
    const got = await send(async (request) => {
      asked.push(request);
      return { op: 'clear-exhausted', ok: true, cleared: true };
    });
    expect(asked).toEqual([{ op: 'clear-exhausted', routeId: API_KEY.route.id }]);
    expect(got).toMatchObject({
      status: 'applied',
      outcome: { routeId: API_KEY.route.id, cleared: 'true' },
    });
  });

  it('nothing was exhausted → applied with cleared false (the hop says so)', async () => {
    expect(
      await send(async () => ({ op: 'clear-exhausted', ok: true, cleared: false })),
    ).toMatchObject({
      status: 'applied',
      outcome: { cleared: 'false' },
    });
  });

  it.each([
    ['unwired hop', undefined, 'hop-unwired'],
    [
      'hop unreachable',
      async (): Promise<HopControlReply> => {
        throw new Error('ECONNREFUSED 127.0.0.1');
      },
      'hop-unreachable',
    ],
    [
      'hop refusal',
      async (): Promise<HopControlReply> => ({
        op: 'clear-exhausted',
        ok: false,
        code: 'unknown-route',
        detail: 'no such route',
      }),
      'hop-refused',
    ],
    [
      'foreign reply',
      async (): Promise<HopControlReply> => ({ op: 'unregister', ok: true }),
      'hop-refused',
    ],
  ] as const)('%s → rejected %s, never «cleared»', async (_name, port, code) => {
    expect(await send(port)).toMatchObject({ status: 'rejected', code });
  });

  it('a route outside the task allowed set → unknown-route, the hop is not asked', async () => {
    let asked = 0;
    const got = await send(async () => {
      asked += 1;
      return { op: 'clear-exhausted', ok: true, cleared: true };
    }, 'gateway:other');
    expect(got).toMatchObject({ status: 'rejected', code: 'unknown-route' });
    expect(asked).toBe(0);
  });
});

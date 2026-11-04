import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { CompatPolicy } from '@agentdeck/contracts/core/routes';
import type { CliAdapter } from '../../adapters/index.ts';
import { createPlaceholderAdapter } from '../../adapters/placeholder/placeholder.ts';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { compat } from '../../routes/compat/compat.ts';
import { createUserRoute } from '../../routes/local/user/user.ts';
import { createStubRoute } from '../../routes/stub/stub.ts';
import {
  compatAdapterOf,
  compatFactsOf,
  compatRecord,
  compatRefusalReason,
  type CompatInputs,
} from './compat-gate.ts';

/**
 * Дорога сессии подаёт судье `compat` факты переходника и маршрута (этап 10): защита ядра
 * (`preToolHooks`/`denyOverlay`) и причина «сервер человека лежит» доходят до решения настоящим
 * путём — настоящий маршрут `local:user` на порту, где никто не слушает, его проба, судья, запись.
 */

async function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const policy = (route: string): CompatPolicy => ({
  allowed: [{ adapter: 'claude', route, modelPattern: '*' }],
  dlp: { required: false, parses: [] },
  translations: [],
  needsTools: false,
});

/** Переходник с возможностями заготовки, но «построенный»: защита ядра — по флагам. */
function adapterWith(preToolHooks: boolean, denyOverlay: boolean): CliAdapter {
  const base = createPlaceholderAdapter(claudeRunFacts);
  const { built: _built, ...rest } = base;
  return {
    ...rest,
    caps: {
      ...base.caps,
      preToolHooks,
      denyOverlay,
      channels: [{ via: 'env', dialect: 'openai-chat', keyVar: 'K', perSession: true }],
      limitsChannel: 'env',
    },
  };
}

describe('compat gate — facts the session road feeds the judge (stage 10)', () => {
  it('a down local:user server refuses user_server_down with the probe reason in the journal record', async () => {
    const port = await deadPort();
    const route = createUserRoute({
      route: { id: 'llama', baseUrl: `http://127.0.0.1:${port}`, dialect: 'openai-chat' },
      env: {},
      probeTimeoutMs: 2_000,
    });
    const adapter = compatAdapterOf(adapterWith(true, false));
    const facts = await compatFactsOf(route, 'qwen3-0.6b');
    expect(facts.route.availability.state).toBe('absent');
    expect(facts.route.availability.downReason).toMatch(/^user_server_down: /);
    const decision = compat(adapter, facts.route, facts.model, policy(route.id));
    expect(decision).toMatchObject({ kind: 'refused', code: 'user_server_down' });
    const inputs: CompatInputs = { adapter, facts, policy: policy(route.id) };
    const record = compatRecord(decision, inputs);
    expect(record.reasons[0]).toBe('refused: user_server_down');
    expect(record.reasons[1]).toMatch(/^user_server_down: connection refused/);
  });

  it('a route that is absent without a human-server probe stays route_unavailable', async () => {
    const stub = createStubRoute({ name: 'x', script: ['x'] });
    const route = {
      ...stub,
      read: { ...stub.read, availability: async () => ({ absent: true as const }) },
    };
    const facts = await compatFactsOf(route, 'x');
    expect(facts.route.availability).not.toHaveProperty('downReason');
    const decision = compat(
      compatAdapterOf(adapterWith(true, false)),
      facts.route,
      facts.model,
      policy(route.id),
    );
    expect(decision).toMatchObject({ kind: 'refused', code: 'route_unavailable' });
  });

  it('adapter caps reach the judge: neither hook nor overlay refuses no_core_hook, either one passes', async () => {
    const stub = createStubRoute({ name: 'x', script: ['x'] });
    const facts = await compatFactsOf(stub, 'stub-model');
    const verdict = (hook: boolean, overlay: boolean) =>
      compat(compatAdapterOf(adapterWith(hook, overlay)), facts.route, facts.model, {
        ...policy(stub.id),
      });
    expect(verdict(false, false)).toMatchObject({ kind: 'refused', code: 'no_core_hook' });
    expect(verdict(true, false)).toMatchObject({ kind: 'direct' });
    expect(verdict(false, true).kind).toBe('direct');
    expect(compatAdapterOf(adapterWith(false, true)).caps).toMatchObject({
      preToolHooks: false,
      denyOverlay: true,
    });
  });

  it('a model outside the route list is refused model_absent, and the step reason names the model and the route', async () => {
    const stub = createStubRoute({ name: 'x', script: ['x'] });
    const facts = await compatFactsOf(stub, 'gpt-4o');
    const decision = compat(
      compatAdapterOf(adapterWith(true, true)),
      facts.route,
      facts.model,
      policy(stub.id),
    );
    expect(decision).toMatchObject({ kind: 'refused', code: 'model_absent' });
    const code = decision.kind === 'refused' ? decision.code : '';
    expect(compatRefusalReason(code, 'gpt-4o', stub.id)).toBe(
      `compat refused: model_absent: model gpt-4o is not in the model list of route ${stub.id}`,
    );
    expect(compatRefusalReason('no_channel', 'gpt-4o', stub.id)).toBe('compat refused: no_channel');
  });
});

import { describe, expect, it } from 'vitest';
import type { CompatAdapter, CompatPolicy, CompatRoute } from '@agentdeck/contracts/core/routes';
import { createCliLoginRoute } from './cli-login.ts';
import { compat } from '../compat/compat.ts';

/**
 * Вход CLI идёт к вендору сам, без адреса (11 R:PR-02): DLP-звену негде встать, поэтому маршрут
 * никогда не объявляет себя разбираемым — даже если вызывающий попросил (core-s2 F-93).
 */

const adapter: CompatAdapter = {
  id: 'claude',
  caps: { login: 'account', channels: [], limitsChannel: null },
  bypassActive: {},
};
const policy = (required: boolean): CompatPolicy => ({
  allowed: [{ adapter: 'claude', route: 'cli-login:claude', modelPattern: '*' }],
  dlp: { required, parses: ['anthropic-messages', 'openai-chat', 'openai-responses'] },
  translations: [],
  needsTools: false,
});
const model = { id: 'm-1', served: 'value' as const, contextTokens: 32_000, tools: true };

function routeOf(options: Parameters<typeof createCliLoginRoute>[1]): CompatRoute {
  return {
    id: 'cli-login:claude',
    caps: createCliLoginRoute({ id: 'claude' }, options).caps,
    availability: { state: 'unknown', onUnknown: 'run' },
    credential: 'unknown',
  };
}

describe('cli-login route — no masking road, never maskable (F-93)', () => {
  // Вызывающий, который по-старому передаёт `maskable: true` (объект не литералом — как из
  // настроек), не получает разбираемый маршрут: дороги маскирования у входа CLI нет.
  const asked = { loginState: async () => true, maskable: true };

  it('a DLP-required step is refused on cli-login, whatever the caller declared', () => {
    for (const options of [undefined, asked]) {
      const route = routeOf(options);
      expect(route.caps.maskable).toBe(false);
      expect(compat(adapter, route, model, policy(true))).toMatchObject({
        kind: 'refused',
        code: 'dlp_opaque',
      });
    }
  });

  it('without the DLP requirement cli-login stays a direct login route', () => {
    expect(compat(adapter, routeOf(asked), model, policy(false))).toMatchObject({
      kind: 'direct',
      channel: { via: 'login' },
    });
  });
});

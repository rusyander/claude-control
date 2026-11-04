import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CompatAdapter,
  CompatPolicy,
  Route,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import { createCliLoginRoute } from '../../routes/cli-login/cli-login.ts';
import { compat } from '../../routes/compat/compat.ts';
import { modelRequired, RouteRefused } from '../../routes/lease.ts';
import { ownDir, ownOptions } from '../../routes/local/own/__fixtures__/own-options.ts';
import { createOwnRoute } from '../../routes/local/own/own.ts';
import { createSlotQueue } from '../../routes/local/own/slot.ts';
import { createStubRoute } from '../../routes/stub/stub.ts';
import { compatFactsOf } from './compat-gate.ts';

/**
 * Модель по умолчанию CLI (`model: null`, оценка без потолка) — `null` по всему пути, без знака-
 * заменителя: вход CLI подаёт её без чтения списка моделей и выдаёт аренду с `model: null`;
 * суд `compat` пропускает её только под шаблоном «любая» и только у входа CLI; маршруты с адресом
 * (заглушка, своя модель) отказывают `model_absent`, называя себя, до любого ресурса.
 */

const adapter: CompatAdapter = {
  id: 'claude',
  caps: {
    login: 'account',
    channels: [],
    limitsChannel: null,
    preToolHooks: true,
    denyOverlay: true,
  },
  bypassActive: {},
};
const policy = (modelPattern: string, route = 'cli-login:claude'): CompatPolicy => ({
  allowed: [{ adapter: 'claude', route, modelPattern }],
  dlp: { required: false, parses: [] },
  translations: [],
  needsTools: false,
});

function loginRoute(): { route: Route; modelReads: () => number } {
  const base = createCliLoginRoute({ id: 'claude' }, { loginState: async () => true });
  let reads = 0;
  const route: Route = {
    ...base,
    read: {
      ...base.read,
      models: async () => {
        reads += 1;
        return base.read.models();
      },
    },
  };
  return { route, modelReads: () => reads };
}

function recorder(): { record: RouteRecorder; created: string[] } {
  const created: string[] = [];
  return {
    created,
    record: {
      created: (r) => void created.push(r.rid),
      decision: () => undefined,
      verified: () => undefined,
      leak: () => undefined,
    },
  };
}

const REFUSAL = /needs a concrete model; the tier picked the CLI default/;

describe('CLI default model (model null) through the compat gate and the road', () => {
  it('cli-login facts for model null: id null, served value, the model list is not read', async () => {
    const { route, modelReads } = loginRoute();
    const facts = await compatFactsOf(route, null);
    expect(facts.model).toEqual({ id: null, served: 'value' });
    expect(modelReads()).toBe(0);
    expect(facts.facts.map((f) => f.readClass)).not.toContain('route.models');
    expect(facts.route.id).toBe('cli-login:claude');
  });

  it('allowed pattern "*" passes the CLI default; a narrower pattern refuses it (the CLI choice could leave it)', async () => {
    const { route } = loginRoute();
    const facts = await compatFactsOf(route, null);
    expect(compat(adapter, facts.route, facts.model, policy('*'))).toMatchObject({
      kind: 'direct',
    });
    for (const narrow of ['claude-*', '*-opus', 'sonnet'])
      expect(compat(adapter, facts.route, facts.model, policy(narrow))).toMatchObject({
        kind: 'refused',
        code: 'not_allowed',
      });
  });

  it('compat: an endpoint route with model null is refused model_absent, even under pattern "*"', () => {
    const endpoint = {
      id: 'stub:x',
      caps: { ...createStubRoute({ name: 'x', script: ['x'] }).caps },
      availability: { state: 'value' as const, onUnknown: 'refuse' as const },
      credential: 'none' as const,
    };
    expect(
      compat(adapter, endpoint, { id: null, served: 'value' }, policy('*', 'stub:x')),
    ).toMatchObject({ kind: 'refused', code: 'model_absent' });
  });

  it('modelRequired: cli-login or a named model passes; an endpoint route without a model is refused by name', () => {
    const { route } = loginRoute();
    expect(modelRequired(route, null)).toBeNull();
    const endpoint: Route = {
      ...route,
      id: 'endpoint:x',
      caps: { ...route.caps, binding: { via: 'endpoint' } },
    };
    expect(modelRequired(endpoint, 'm-1')).toBeNull();
    expect(modelRequired(endpoint, null)).toMatch(
      /^route endpoint:x needs a concrete model; the tier picked the CLI default/,
    );
  });

  it('routes: cli-login leases model null; stub and local:own refuse model_absent naming the route before any resource', async () => {
    const { route } = loginRoute();
    const login = await route.acquire({ taskId: 't', model: null }, recorder().record);
    expect(login).toMatchObject({ routeId: 'cli-login:claude', model: null, resources: [] });

    const stub = createStubRoute({ name: 'nomodel', script: ['x'] });
    const s = recorder();
    const stubRefusal = await stub.acquire({ taskId: 't', model: null }, s.record).catch((e) => e);
    expect(stubRefusal).toBeInstanceOf(RouteRefused);
    expect(stubRefusal).toMatchObject({ code: 'model_absent' });
    expect((stubRefusal as RouteRefused).reason).toMatch(/^route stub:nomodel /);
    expect((stubRefusal as RouteRefused).reason).toMatch(REFUSAL);
    expect(s.created).toEqual([]);

    const layout = ownDir(mkdtempSync(join(tmpdir(), 'own-nomodel-')));
    const own = createOwnRoute({ ...ownOptions(layout), slots: createSlotQueue() });
    const o = recorder();
    const ownRefusal = await own.acquire({ taskId: 't', model: null }, o.record).catch((e) => e);
    expect(ownRefusal).toBeInstanceOf(RouteRefused);
    expect(ownRefusal).toMatchObject({ code: 'model_absent' });
    expect((ownRefusal as RouteRefused).reason).toMatch(new RegExp(`^route ${own.id} `));
    expect(o.created).toEqual([]);
  });
});

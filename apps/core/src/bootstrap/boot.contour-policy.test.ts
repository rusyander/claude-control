import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterEach, describe, expect, it } from 'vitest';
import { decideRouting } from '../conductor/scenario/index.ts';
import { CREATED, MINI_SCENARIO, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Активный контур панели как политика уровня 1 на НАСТОЯЩЕЙ загрузке (W2b, раунд 3): каталог
 * данных панели (временный, только чтение) называет `activePlatformId` и режим карточки. Правило
 * обязательного контура живо в обоих местах, где его судят: команда `set-route` через API ядра и
 * суд `tier` шага (`routingEnv` экономики загрузки). Нет ключа контура — шлюз `down`: отказ, не
 * облако вендора (P118). «По возможности» и «контур не выбран» набор не трогают.
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

const KEY = ['sk-', 'contour', '-policy-0123456789'].join('');
const OWN = 'api-key:endpoint:own';
const GATE = 'gateway:c1';

function panelData(mode: 'required' | 'best-effort' | null, withKey: boolean): string {
  const dir = tempDir('contour-policy-panel-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      settings: {
        dlp: { enabled: false },
        ...(mode ? { activePlatformId: 'c1' } : {}),
        endpointProfiles: [
          { id: 'own', name: 'Свой', baseUrl: 'http://127.0.0.1:9/v1', apiKind: 'openai-compat' },
        ],
        platforms: [
          {
            id: 'c1',
            title: 'Контур',
            driver: 'litellm',
            baseUrl: 'http://127.0.0.1:9',
            mode: mode ?? 'required',
          },
        ],
      },
    }),
  );
  setStoredKey(dir, 'endpoint:own', KEY);
  if (withKey) setStoredKey(dir, 'platform:c1', KEY);
  return dir;
}

async function boot(panelAppData: string): Promise<BootedCore> {
  const core = await bootCore({
    home: join(tempDir('contour-policy-core-'), 'core'),
    build: 'contour-policy-test',
    panelAppData,
    loop: false,
  });
  booted.push(core);
  return core;
}

const triple = (id: string) => ({
  adapter: claudeRunFacts.id,
  route: { kind: id.startsWith('gateway:') ? 'gateway' : 'api-key', id },
  modelPattern: '*',
});

async function setRoute(
  core: BootedCore,
  taskId: string,
  routes: string[],
): Promise<{ status: number; body: string }> {
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
      kind: 'set-route',
      target: { taskId },
      fields: { scope: 'task', scopeId: taskId, allowedRoutes: routes.map(triple) },
      proof: { nonce, page },
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function taskOn(core: BootedCore) {
  return core.registry.create({
    ...CREATED,
    modelCeiling: 'stub-model',
    allowedRoutes: [triple(OWN)] as never,
  });
}

function tierOf(core: BootedCore, task: Awaited<ReturnType<typeof taskOn>>) {
  const def = MINI_SCENARIO.steps[0]!;
  return decideRouting(
    task.state,
    { stepId: null, unitId: null, def },
    core.economy.routingEnv!(task),
  ).tier;
}

describe('boot: the panel active contour is the level-1 policy of set-route and the tier judge', () => {
  it('required + key: set-route past the gateway is refused naming the contour, the gateway alone is applied; the tier takes gateway:c1 for an api-key task', async () => {
    const core = await boot(panelData('required', true));
    const task = await taskOn(core);
    const past = await setRoute(core, task.taskId, [OWN]);
    expect(past.status).toBe(422);
    expect(past.body).toContain('outside-allowed-set');
    expect(past.body).toContain(`contour c1 is required, only ${GATE} is allowed`);
    const tier = tierOf(core, task);
    expect(tier.ok && tier.route).toEqual({ kind: 'gateway', id: GATE });
    expect(tier.reasons.join('\n')).toContain(`contour c1 is required: goes through ${GATE}`);
    expect((await setRoute(core, task.taskId, [GATE])).status).toBe(200);
  });

  it('required without the contour key: gateway down → set-route route_unavailable and the tier refuses, never the vendor route', async () => {
    const core = await boot(panelData('required', false));
    const task = await taskOn(core);
    const gate = await setRoute(core, task.taskId, [GATE]);
    expect(gate.status).toBe(422);
    expect(gate.body).toContain('route_unavailable');
    expect(gate.body).toContain('contour c1 is required and its gateway is down');
    const tier = tierOf(core, task);
    expect(tier.ok).toBe(false);
    expect(tier.reasons[0]).toContain('contour c1 is required and its gateway is down');
  });

  it('best-effort or no active contour: the task set is untouched — set-route takes the api-key route, the tier picks it', async () => {
    for (const mode of ['best-effort', null] as const) {
      const core = await boot(panelData(mode, true));
      const task = await taskOn(core);
      const tier = tierOf(core, task);
      expect(tier.ok && tier.route, String(mode)).toEqual({ kind: 'api-key', id: OWN });
      expect((await setRoute(core, task.taskId, [OWN])).status, String(mode)).toBe(200);
    }
  });
});

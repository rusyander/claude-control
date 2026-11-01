import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { stepInventory } from './index.ts';

/**
 * Опись слоя человека для брифа шага (06:121) в сборе дирижёра: настоящий переходник Claude по суду
 * `tier` шага, копия единицы, пин исполнителя. Навыки репозитория не берутся — доверие копии решает
 * дорога на запуске. До проводки опись давала только подставка стенда e2e.
 */

let root: string;
let copy: string;
let pin: Record<string, string>;

const skill = (dir: string, name: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\nBody.\n`,
  );
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-step-inventory-'));
  const cliHome = join(root, 'cli-home');
  skill(join(cliHome, 'skills'), 'own-skill');
  copy = join(root, 'copy');
  skill(join(copy, '.claude', 'skills'), 'repo-skill');
  pin = { CLAUDE_CONFIG_DIR: cliHome, HOME: cliHome, USERPROFILE: cliHome };
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const step = (over: Record<string, unknown>) =>
  ({ routing: { tier: { ok: true, adapter: 'claude' } }, copyDir: copy, ...over }) as never;

/** Опись шага через порт дирижёра в сборе: реестр переходников ядра + пин цикла. */
async function inventoryOf(s: never) {
  const port = stepInventory({
    adapters: createAdapterRegistry(),
    loop: { pin: () => pin },
  } as never);
  if (!port) throw new Error('conductor wiring gave no step inventory port');
  return await port(s);
}

describe('conductor wiring: step inventory for the brief', () => {
  it('the step tier adapter reads the user layer over the unit copy with the loop pin; repo skills stay out', async () => {
    const got = await inventoryOf(step({}));
    expect(got?.skills.map((s) => s.name)).toEqual(['own-skill']);
  });

  it('no tier adapter or no copy: null, never a guess', async () => {
    expect(await inventoryOf(step({ copyDir: undefined }))).toBeNull();
    expect(await inventoryOf(step({ routing: { tier: { ok: false } } }))).toBeNull();
  });
});

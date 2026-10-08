import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { KitService } from '../../../domains/kit/service.ts';
import { registerKitRoutes } from '../../kit-routes/kit-routes.ts';
import { manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * «Набор панели» через агента панели — настоящий маршрут и сервис над
 * временным каталогом: глобальный слой с одним навыком, совпадающим по имени с
 * навыком набора, и одной командой, которой в наборе нет.
 */

describe('panel-agent actions: kit', () => {
  let root: string;
  let h: ManageHarness;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-kit-'));
    const claude = join(root, '.claude');
    mkdirSync(join(claude, 'skills', 'read-before-edit'), { recursive: true });
    writeFileSync(
      join(claude, 'skills', 'read-before-edit', 'SKILL.md'),
      'mine, not the kit one\n',
    );
    mkdirSync(join(claude, 'commands'), { recursive: true });
    writeFileSync(join(claude, 'commands', 'only-global.md'), '# only global\n');
    const appData = join(claude, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const ctx = {
      store: new AppStore(appData),
      location: { paths: { appData }, source: 'default', isValid: true, missing: [] },
    } as unknown as ServerContext;
    const kit = new KitService({
      appDataDir: appData,
      claudeDir: () => claude,
      providers: () => [{ id: 'claude', name: 'Claude Code' }],
    });
    h = await manageHarness(ctx, (app) => registerKitRoutes(app, ctx, kit, () => undefined));
  });

  afterEach(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('состояние: режим по умолчанию, расхождение с глобальным и то, что есть только там', async () => {
    const read = await h.call('kit_status', {});
    expect(read.outcome).toBe('done');
    const view = read.result as {
      providers: { id: string; mode: string }[];
      items: { id: string; global?: string }[];
      globalOnly: { kind: string; name: string }[];
    };
    expect(view.providers).toEqual([
      { id: 'claude', mode: 'global', modes: ['global', 'hybrid', 'ours'] },
    ]);
    expect(view.items.find((item) => item.id === 'skills/read-before-edit/SKILL.md')?.global).toBe(
      'differs',
    );
    expect(view.globalOnly).toContainEqual({ kind: 'command', name: 'only-global' });
  });
});

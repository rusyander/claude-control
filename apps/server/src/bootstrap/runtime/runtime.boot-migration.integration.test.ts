import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import {
  DEFERRED_ASKS_FILE,
  DeferredAsks,
} from '../../domains/chat/deferred-asks/deferred-asks.ts';
import { createRuntime } from './runtime.ts';

/**
 * Разовая миграция при старте (этап 10, F1) — настоящим путём сборки: `createRuntime` над
 * временным каталогом данных. Недоведённый план прежней группы получает `cancelledAt`, ждущий
 * D-n группы отзывается; второй старт над тем же каталогом ничего не меняет.
 */
describe('createRuntime: недоведённые прежние группы отменяются один раз', () => {
  let root: string | undefined;

  afterEach(() => {
    delete process.env.AGENTDECK_LOCAL_MODELS_DIR;
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = undefined;
  });

  function context(dir: string): ServerContext {
    const appData = join(dir, 'agentdeck');
    return {
      store: new AppStore(appData),
      location: {
        paths: {
          root: dir,
          appData,
          settings: join(dir, 'settings.json'),
          settingsLocal: join(dir, 'settings.local.json'),
          claudeMd: join(dir, 'CLAUDE.md'),
          secretsEnv: join(dir, '.mcp-secrets.env'),
          skills: join(dir, 'skills'),
          hooks: join(dir, 'hooks'),
          mcpConfig: join(dir, '.claude.json'),
        },
      },
      backupDir: join(dir, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
  }

  it('старт отменяет план и отзывает D-n группы; повторный старт — без перемен', () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-boot-migration-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    // Свой каталог локальных моделей: иначе сборка писала бы в настоящий каталог панели.
    process.env.AGENTDECK_LOCAL_MODELS_DIR = join(root, 'local-models');
    const seed = new AppStore(appData);
    seed.setSplitPlan({
      parentChatId: 'half',
      projectPath: join(root, 'repo'),
      createdAt: '2026-10-01T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [] },
      groups: [{ index: 0, title: 'g', branch: 'b', after: [], status: 'started' }],
    } as unknown as SplitPlanRecord);
    new DeferredAsks({ file: join(appData, DEFERRED_ASKS_FILE) }).ask({
      scope: { kind: 'group', parentChatId: 'half', groupIndex: 0 },
      runKeys: ['g'],
      toolName: 'Bash',
      input: { command: 'git push origin b' },
      reason: 'r',
    });

    const first = context(root);
    createRuntime(first, 'http://127.0.0.1:1').shutdown();
    const cancelledAt = new AppStore(appData).getSplitPlans().half?.cancelledAt;
    expect(cancelledAt).toBeTruthy();
    const asks = () => new DeferredAsks({ file: join(appData, DEFERRED_ASKS_FILE) }).all();
    expect(asks().map((record) => record.state)).toEqual(['withdrawn']);

    createRuntime(context(root), 'http://127.0.0.1:1').shutdown();
    expect(new AppStore(appData).getSplitPlans().half?.cancelledAt).toBe(cancelledAt);
    expect(asks().map((record) => record.state)).toEqual(['withdrawn']);
  });
});

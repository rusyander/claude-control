import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { SplitOverlap } from '../../domains/chat/split-overlap/split-overlap.ts';
import { createRuntime } from './runtime.ts';

/**
 * Тики сборки гаснут вместе с ней. Пересчёт пересечений групп по расписанию
 * (`SplitOverlap.watchDrift`) возвращает функцию остановки; сборка её теряла, и после
 * `shutdown` тик продолжал звать git в проектах групп — в тестах это рвало уборку
 * временных папок, в панели — пересчёт на уже закрытом хранилище. Путь настоящий:
 * `createRuntime` и его `shutdown`; обёрнут только сам тик, чтобы увидеть остановку.
 */
describe('runtime.shutdown снимает тики, которые завела сборка', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENTDECK_LOCAL_MODELS_DIR;
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = undefined;
  });

  it('пересчёт пересечений групп по расписанию остановлен', () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-shutdown-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    const ctx = {
      store: new AppStore(appData),
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    // Свой каталог локальных моделей: иначе сборка писала бы в настоящий каталог панели.
    process.env.AGENTDECK_LOCAL_MODELS_DIR = join(root, 'local-models');

    const original = SplitOverlap.prototype.watchDrift;
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(SplitOverlap.prototype, 'watchDrift').mockImplementation(function (
      this: SplitOverlap,
      ...args: Parameters<SplitOverlap['watchDrift']>
    ) {
      const stop = vi.fn(original.apply(this, args));
      stops.push(stop);
      return stop;
    });

    const runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    expect(stops).toHaveLength(1);
    expect(stops[0]).not.toHaveBeenCalled();
    runtime.shutdown();
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { createRuntime } from './runtime.ts';

/**
 * Пересылка вопросов ядра гаснет вместе с панелью: `shutdown` сборки снимает её таймер и потоки и
 * дописывает курсор, иначе выход по Ctrl+C терял последнюю секунду курсора, а тесты сборки — опрос
 * ядра после уборки. Путь настоящий: `createRuntime` → `wireNotify` → `wireCoreRelay`; подменена
 * только сама пересылка (настоящая пошла бы к ядру и в дом панели этой машины).
 */
const relay = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  tick: vi.fn(),
}));

vi.mock('../../domains/core-relay/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/core-relay/index.ts')>()),
  createCoreRelay: () => relay,
}));

describe('runtime.shutdown останавливает пересылку вопросов ядра', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = undefined;
  });

  it('пересылка заведена сборкой и остановлена её shutdown', () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-relay-')));
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
    vi.stubEnv('AGENTDECK_LOCAL_MODELS_DIR', join(root, 'local-models'));
    // Под vitest пересылка не заводится — снимаем только этот запрет; надзор ядра выключен явно.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('AGENTDECK_CORE_SUPERVISE', '0');

    const runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    expect(relay.start).toHaveBeenCalledTimes(1);
    expect(relay.stop).not.toHaveBeenCalled();
    runtime.shutdown();
    expect(relay.stop).toHaveBeenCalledTimes(1);
  });
});

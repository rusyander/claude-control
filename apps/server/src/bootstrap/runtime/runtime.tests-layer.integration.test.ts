import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { memoryContours } from '../../domains/platform/contours/__fixtures__/memory-contours.ts';
import {
  FAKE_TURN,
  fakeCorePort,
  waitFor,
} from '../../domains/project-tests/agent/__fixtures__/fake-core-port.ts';
import { createGroup, upsertCase } from '../../domains/project-tests/store/store.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Агент блока «Тесты» на Claude получает слой панели (этап 10, G13) на проводке сборки: реестр
 * прогонов из `createRuntime`, его решатель слоя (`runRoute('tests')` → `KitService` на диске →
 * `carryOfTestsRoute`). Подменена только граница процесса ядра (`setCorePort`). Прежний прогон
 * (HEAD `runs.ts` `launch`) клал `--plugin-dir`/`--setting-sources` набора и его переменные в
 * argv своего CLI; через ядро они идут полями `session` оценки и значениями `env`, а дальше в argv
 * переходника — тест ядра `conductor-wiring/session-carry.integration.test.ts`.
 */
describe('tests agent on Claude carries the panel layer (runtime runRoute tests → core estimate)', () => {
  let root: string;
  let project: string;
  let runtime: Runtime;
  const now = '2026-11-02T00:00:00.000Z';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-tests-layer-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    project = join(root, 'project');
    mkdirSync(project);
    createGroup(project, 'gui');
    upsertCase(project, 'gui', { title: 'A', steps: ['x'] }, now);
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
    process.env.AGENTDECK_LOCAL_MODELS_DIR = join(root, 'local-models');
    runtime = createRuntime(ctx, 'http://127.0.0.1:1', { contours: memoryContours() });
  });

  afterEach(() => {
    runtime.projectTestRuns.stop(project);
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    delete process.env.AGENTDECK_LOCAL_MODELS_DIR;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const kitDir = (mode: string) =>
    join(root, 'agentdeck', 'kit', 'effective', mode, 'agentdeck-kit');

  async function run(provider?: { id: 'claude' | 'qwen' | 'codex'; name: string }) {
    const core = fakeCorePort({ turn: FAKE_TURN });
    runtime.projectTestRuns.setCorePort(core.port);
    runtime.projectTestRuns.start(
      { projectPath: project, mode: 'run', groupId: 'gui' },
      now,
      undefined,
      () => ({ values: { STAND_PASSWORD: 'stand-secret' }, missing: [] }),
      provider ? { provider } : {},
    );
    await waitFor(() => runtime.projectTestRuns.get(project)?.status !== 'running', 10_000);
    return core;
  }

  it('kit «ours»: plugin + narrowed sources + kit vars beside the stand secret and the write scope', async () => {
    runtime.kit.setMode('claude', 'ours');
    const core = await run();
    expect(runtime.projectTestRuns.get(project)?.status).toBe('done');
    const session = core.estimates[0]?.session;
    expect(session?.plugins).toEqual([kitDir('ours')]);
    expect(session?.settingSources).toEqual(['project', 'local']);
    expect(session?.scope?.edit).toEqual(['.agent/tests', '.agent/tests/**']);
    // Дописки прежний прогон тестов не получал — её нет и через ядро.
    expect(session?.append).toBeUndefined();
    expect(core.envs[0]).toMatchObject({
      STAND_PASSWORD: 'stand-secret',
      AGENTDECK_KIT_VARIANT: 'standard',
      AGENTDECK_TESTS_NOTE: '1',
    });
    expect([...(session?.env ?? [])].sort()).toEqual(Object.keys(core.envs[0] ?? {}).sort());
  });

  it('Qwen Code: no layer, as before (HEAD launchForeign had no route)', async () => {
    runtime.kit.setMode('qwen', 'ours');
    const core = await run({ id: 'qwen', name: 'Qwen Code' });
    const session = core.estimates[0]?.session;
    expect(session?.plugins).toBeUndefined();
    expect(core.envs[0]).toEqual({ STAND_PASSWORD: 'stand-secret' });
  });
});

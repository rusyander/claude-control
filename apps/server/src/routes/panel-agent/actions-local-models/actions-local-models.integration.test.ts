import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { createLocalModels, loadCatalog } from '../../../domains/local-models/service.ts';
import { localPaths } from '../../../domains/local-models/paths.ts';
import { modelFilePath } from '../../../domains/local-models/hf.ts';
import { KitService } from '../../../domains/kit/service.ts';
import { registerLocalModelsRoutes } from '../../local-models-routes/local-models-routes.ts';
import { manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * «Локальные модели» через агента панели — настоящий маршрут и сервис над
 * временным каталогом: модель лежит на диске файлом GGUF, железо —
 * строкой nvidia-smi, сервера моделей нет (порт, где никто не слушает).
 */

const TAG = 'qwen3.5:4b';

describe('panel-agent actions: local models', () => {
  let root: string;
  let h: ManageHarness;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-local-'));
    const lm = join(root, 'lm');
    const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: lm });
    // Модель скачана: файл лежит там, где его оставляет загрузка из репозитория.
    const model = loadCatalog().models.find((item) => item.tag === TAG);
    const quant = model?.quants.find((item) => item.id === model.defaultQuant);
    if (!model || !quant) throw new Error(`${TAG} not in catalog`);
    const file = modelFilePath(paths, model.repo, quant.file);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'weights');
    const local = createLocalModels({
      appRoot: root,
      env: {
        AGENTDECK_LOCAL_MODELS_DIR: lm,
        OLLAMA_MODELS: join(root, 'no-system-models'),
        PATH: '',
        LOCALAPPDATA: join(root, 'appdata'),
        ProgramFiles: join(root, 'programs'),
        HOME: root,
        USERPROFILE: root,
      },
      port: 1,
      run: async (cmd) => {
        if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 20000\n';
        throw new Error(`no ${cmd}`);
      },
      spawnServer: () => {
        throw new Error('reading must not start a server');
      },
    });
    const appData = join(root, '.claude', 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const ctx = {
      store: new AppStore(appData),
      location: { paths: { appData }, source: 'default', isValid: true, missing: [] },
    } as unknown as ServerContext;
    const kit = new KitService({
      appDataDir: appData,
      claudeDir: () => join(root, '.claude'),
      providers: () => [],
    });
    h = await manageHarness(ctx, (app) => registerLocalModelsRoutes(app, ctx, local, kit));
  });

  afterEach(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('состояние: видеокарта, установленная модель, сервер не запущен — и ничего не запущено', async () => {
    const read = await h.call('local_models_status', {});
    expect(read.outcome).toBe('done');
    const view = read.result as {
      hardware: { gpus: { name: string }[] };
      server: { running: boolean };
      installed: { tag: string }[];
      runningJobs: number;
    };
    expect(view.hardware.gpus.map((gpu) => gpu.name)).toEqual(['NVIDIA GeForce RTX 4090']);
    expect(view.installed.map((model) => model.tag)).toEqual([TAG]);
    expect(view.server.running).toBe(false);
    expect(view.runningJobs).toBe(0);
  });
});

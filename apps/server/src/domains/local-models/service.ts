import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_MIN_CONTEXT,
  fitModel,
  gpuTableSchema,
  modelCatalogSchema,
  recommendModel,
  type CatalogModel,
  type HardwareInfo,
  type InstalledModel,
  type KitMode,
  type LocalJob,
  type LocalModelsInfo,
  type LocalRuntimeInfo,
  type LocalServerInfo,
  type ModelBench,
  type ModelCatalog,
} from '@agentdeck/contracts/local-models';
import { connectLocal, describeConnect, disconnectLocal, type Inject } from './connect.ts';
import { localError } from './errors.ts';
import { detectHardware, type RunCommand } from './hardware.ts';
import { LocalJobs } from './jobs.ts';
import { ollamaClient, type FetchLike, type PullEvent } from './ollama-client.ts';
import {
  LOCAL_SERVER_PORT,
  ensureDirs,
  localPaths,
  readState,
  updateState,
  type LocalPaths,
} from './paths.ts';
import { addQwenToPath, describeQwenCode, installQwenCode } from './qwen-code.ts';
import {
  MIN_OLLAMA_VERSION,
  compareVersions,
  fetchLatestRelease,
  findPanelBinary,
  findSystemBinary,
  installPanelRuntime,
  panelRuntimeVersion,
  pickRuntime,
} from './runtime.ts';
import { baseUrlOf, probe, readRecord, startServer, stopServer } from './server.ts';
import {
  dirSize,
  dropPartials,
  importStoredModel,
  listStoredModels,
  manifestPathOf,
  systemModelsDir,
} from './store.ts';

/**
 * Раздел «Локальные модели» одним объектом: живёт дольше запроса (работы с
 * прогрессом, кеш железа) и гасится при выходе панели.
 *
 * Сервер моделей при выходе НЕ останавливается: он отдельный процесс, и
 * перезапуск панели подхватывает его по записи. Видеопамять при этом не
 * держится — простаивающая модель выгружается сама через десять минут
 * (`OLLAMA_KEEP_ALIVE`), а «Остановить» на странице выгружает сразу.
 */

const DATA = new URL('./data/', import.meta.url);
/** Железо меряется не на каждый опрос страницы: `nvidia-smi` и PowerShell — сотни миллисекунд. */
const HARDWARE_TTL_MS = 15_000;
const RELEASE_TTL_MS = 60 * 60_000;

export function loadCatalog(): ModelCatalog {
  return modelCatalogSchema.parse(
    JSON.parse(readFileSync(new URL('catalog.json', DATA), 'utf8')) as unknown,
  );
}

export function loadGpuTable(): ReturnType<typeof gpuTableSchema.parse> {
  return gpuTableSchema.parse(
    JSON.parse(readFileSync(new URL('gpus.json', DATA), 'utf8')) as unknown,
  );
}

/** Сумма слоёв потока `/api/pull`: у каждого свой `digest`, свой `total` и `completed`. */
export function pullProgress(layers: Map<string, { total: number; completed: number }>): {
  doneBytes: number;
  totalBytes: number;
} {
  let doneBytes = 0;
  let totalBytes = 0;
  for (const layer of layers.values()) {
    doneBytes += layer.completed;
    totalBytes += layer.total;
  }
  return { doneBytes, totalBytes };
}

/** Этап загрузки по строке Ollama — код для словаря экрана. */
export function pullPhase(status: string): string {
  if (status.startsWith('pulling manifest')) return 'manifest';
  if (status.startsWith('pulling')) return 'pull';
  if (status.startsWith('verifying')) return 'verify';
  if (status.startsWith('writing') || status === 'success') return 'finish';
  return 'pull';
}

export function benchOf(
  result: {
    evalCount: number;
    evalDurationNs: number;
    promptCount: number;
    promptDurationNs: number;
  },
  gpu: string,
  now = new Date(),
): ModelBench {
  const rate = (count: number, ns: number): number =>
    ns > 0 ? Math.round((count / (ns / 1e9)) * 10) / 10 : 0;
  return {
    tokensPerSec: rate(result.evalCount, result.evalDurationNs),
    promptTokensPerSec: rate(result.promptCount, result.promptDurationNs),
    measuredAt: now.toISOString(),
    gpu,
  };
}

export interface LocalModelsDeps {
  appRoot: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  run?: RunCommand;
  port?: number;
  os?: NodeJS.Platform;
  /** Подмена запуска сервера для проверок. */
  spawnServer?: Parameters<typeof startServer>[0]['spawnImpl'];
}

export type LocalModels = ReturnType<typeof createLocalModels>;

export function createLocalModels(deps: LocalModelsDeps) {
  const env = deps.env ?? process.env;
  const os = deps.os ?? platform();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const port = deps.port ?? LOCAL_SERVER_PORT;
  const paths: LocalPaths = localPaths(deps.appRoot, env);
  const catalog = loadCatalog();
  const table = loadGpuTable().gpus;
  const jobs = new LocalJobs();
  const client = ollamaClient(baseUrlOf(port), fetchImpl);
  let hardware: { at: number; value: HardwareInfo } | undefined;
  let release: { at: number; value?: { version: string; sizeBytes: number } } | undefined;

  addQwenToPath(paths, env);

  async function readHardware(force = false): Promise<HardwareInfo> {
    if (!force && hardware && Date.now() - hardware.at < HARDWARE_TTL_MS) return hardware.value;
    const value = await detectHardware({
      table,
      platform: os,
      root: deps.appRoot,
      ...(deps.run ? { run: deps.run } : {}),
    });
    hardware = { at: Date.now(), value };
    return value;
  }

  function runtimeBinary(): { source: LocalRuntimeInfo['source']; binary: string; system: string } {
    const system = findSystemBinary(os, env);
    const panel = findPanelBinary(paths, os);
    const picked = pickRuntime(system, panel, readState(paths).preferPanelRuntime);
    return { ...picked, system };
  }

  async function latestRelease(): Promise<{ version: string; sizeBytes: number } | undefined> {
    if (release && Date.now() - release.at < RELEASE_TTL_MS) return release.value;
    try {
      const info = await fetchLatestRelease(fetchImpl);
      release = {
        at: Date.now(),
        value: {
          version: info.version,
          sizeBytes: info.assets.reduce((sum, asset) => sum + asset.size, 0),
        },
      };
    } catch {
      // Нет сети — кнопка «Скачать» всё равно есть, размер узнается при загрузке.
      release = { at: Date.now() };
    }
    return release.value;
  }

  async function describeRuntime(): Promise<LocalRuntimeInfo> {
    const { source, binary, system } = runtimeBinary();
    const state = readState(paths);
    const version =
      (binary && state.versions[binary]) || (source === 'panel' ? panelRuntimeVersion(binary) : '');
    const latest = source === 'none' ? await latestRelease() : undefined;
    return {
      source,
      binary,
      version,
      outdated: Boolean(version) && compareVersions(version, MIN_OLLAMA_VERSION) < 0,
      systemBinary: system,
      ...(latest ? { latest } : {}),
    };
  }

  async function describeServer(): Promise<LocalServerInfo> {
    const version = await probe(port, fetchImpl);
    const record = readRecord(paths);
    const base: LocalServerInfo = {
      running: version !== undefined,
      port,
      baseUrl: baseUrlOf(port),
      loaded: [],
      context: record?.context ?? 0,
      ...(record?.pid ? { pid: record.pid } : {}),
    };
    if (version === undefined) return base;
    if (record?.binary && version) {
      const known = readState(paths).versions[record.binary];
      if (known !== version)
        updateState(paths, (state) => {
          state.versions[record.binary] = version;
        });
    }
    try {
      const loaded = await client.ps();
      return {
        ...base,
        loaded: loaded.map((model) => ({
          tag: model.name,
          vramBytes: model.size_vram,
          until: model.expires_at,
        })),
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function installed(): Promise<InstalledModel[]> {
    const bench = readState(paths).bench;
    const known = new Set(catalog.models.map((model) => model.tag));
    return (await listStoredModels(paths.models)).map((model) => ({
      tag: model.tag,
      sizeBytes: model.sizeBytes,
      modifiedAt: model.modifiedAt,
      known: known.has(model.tag),
      ...(bench[model.tag] ? { bench: bench[model.tag] } : {}),
    }));
  }

  async function importable(own: InstalledModel[]): Promise<{ tag: string; sizeBytes: number }[]> {
    const fromDir = systemModelsDir(env);
    if (fromDir === paths.models) return [];
    const mine = new Set(own.map((model) => model.tag));
    return (await listStoredModels(fromDir))
      .filter((model) => !mine.has(model.tag))
      .map((model) => ({ tag: model.tag, sizeBytes: model.sizeBytes }));
  }

  function catalogModel(tag: string): CatalogModel | undefined {
    return catalog.models.find((model) => model.tag === tag);
  }

  /** Контекст, с которым модель встанет на эту карту; чужая модель — агентский минимум. */
  async function contextFor(tag: string): Promise<number> {
    const hw = await readHardware(true);
    const model = catalogModel(tag);
    if (!model) return AGENT_MIN_CONTEXT;
    return fitModel(model, hw.gpus[0], hw.ramGb).context;
  }

  async function recommendedContext(): Promise<number> {
    const hw = await readHardware();
    return recommendModel(catalog.models, hw.gpus[0], hw.ramGb)?.fit.context ?? AGENT_MIN_CONTEXT;
  }

  /**
   * Поднять сервер с нужным контекстом. Контекст задаётся на весь сервер, поэтому
   * другой контекст = перезапуск; тот же — сервер подхватывается как есть.
   */
  async function ensureServer(context: number): Promise<void> {
    const record = readRecord(paths);
    const running = (await probe(port, fetchImpl)) !== undefined;
    if (running && record && record.context === context) return;
    if (running && record) await stopServer(paths, port, fetchImpl);
    const { binary } = runtimeBinary();
    if (!binary)
      throw localError('local-runtime-missing', 'сервер моделей не установлен — нажмите «Скачать»');
    ensureDirs(paths);
    await dropPartials(paths.models);
    const started = await startServer({
      paths,
      binary,
      port,
      context,
      fetchImpl,
      ...(deps.spawnServer ? { spawnImpl: deps.spawnServer } : {}),
    });
    if (started.version)
      updateState(paths, (state) => {
        state.versions[binary] = started.version;
      });
  }

  async function connect(inject: Inject, tag: string): Promise<unknown> {
    const own = await listStoredModels(paths.models);
    if (!own.some((model) => model.tag === tag))
      throw localError('local-model-missing', `модель ${tag} не скачана`, { tag });
    await ensureServer(await contextFor(tag));
    return connectLocal(inject, {
      baseUrl: baseUrlOf(port),
      model: tag,
      title: catalogModel(tag)?.title ?? tag,
    });
  }

  return {
    paths,
    jobs,

    async describe(): Promise<LocalModelsInfo> {
      const [hw, runtime, server, own] = await Promise.all([
        readHardware(),
        describeRuntime(),
        describeServer(),
        installed(),
      ]);
      const state = readState(paths);
      return {
        root: paths.root,
        hardware: hw,
        runtime,
        server,
        catalog,
        installed: own,
        importable: await importable(own),
        jobs: jobs.list(),
        connect: { configured: false, active: false, model: '' },
        qwenCode: describeQwenCode(paths, env),
        kit: state.kit,
        diskUsedBytes: await dirSize(paths.root),
      };
    },

    describeConnect,

    refreshHardware: () => readHardware(true),

    installRuntime(): LocalJob {
      return jobs.start('runtime', 'ollama', async (handle) => {
        const hw = await readHardware();
        ensureDirs(paths);
        await installPanelRuntime({ paths, os, cpu: arch(), gpus: hw.gpus, handle, fetchImpl });
        // Своя сборка поставлена по кнопке — ею и пользоваться, даже если в
        // системе найдётся другая.
        updateState(paths, (state) => {
          state.preferPanelRuntime = true;
        });
      });
    },

    async startServer(tag?: string): Promise<LocalServerInfo> {
      await ensureServer(tag ? await contextFor(tag) : await recommendedContext());
      return describeServer();
    },

    async stopServer(): Promise<{ unloaded: string[] }> {
      return stopServer(paths, port, fetchImpl);
    },

    /**
     * Скачать модель. С `inject` — по готовности ещё и включить её агентам:
     * так кнопка под чатом доводит дело до конца, даже если вкладку закрыли.
     */
    pull(tag: string, inject?: Inject): LocalJob {
      if (!catalogModel(tag))
        throw localError('local-model-unknown', `модели ${tag} нет в каталоге`, { tag });
      return jobs.start('model', tag, async (handle) => {
        handle.progress({ phase: 'server' });
        // Скачиванию контекст безразличен: идущий сервер не перезапускаем ради
        // него (это выгрузило бы модель, с которой сейчас работает агент).
        await ensureServer(readRecord(paths)?.context || (await contextFor(tag)));
        const layers = new Map<string, { total: number; completed: number }>();
        await client.pull(
          tag,
          (event: PullEvent) => {
            if (event.digest && event.total)
              layers.set(event.digest, { total: event.total, completed: event.completed ?? 0 });
            handle.progress({ phase: pullPhase(event.status), ...pullProgress(layers) });
          },
          handle.signal,
        );
        if (inject) {
          handle.progress({ phase: 'connect' });
          await connect(inject, tag);
        }
      });
    },

    importFromSystem(tag: string): LocalJob {
      return jobs.start('model', tag, async (handle) => {
        await importStoredModel({
          fromDir: systemModelsDir(env),
          toDir: paths.models,
          tag,
          handle,
        });
      });
    },

    async remove(tag: string): Promise<void> {
      if ((await probe(port, fetchImpl)) !== undefined) {
        await client.remove(tag);
        return;
      }
      // Сервер остановлен — удаляем манифест сами; слои без манифеста сервер
      // уберёт при следующем запуске (это его штатная чистка).
      await rm(manifestPathOf(paths.models, tag), { force: true });
    },

    async bench(tag: string): Promise<ModelBench> {
      await ensureServer(readRecord(paths)?.context ?? (await contextFor(tag)));
      const hw = await readHardware();
      const result = benchOf(await client.bench(tag), hw.gpus[0]?.name ?? 'cpu');
      updateState(paths, (state) => {
        state.bench[tag] = result;
      });
      return result;
    },

    connect,

    disconnect: (inject: Inject) => disconnectLocal(inject),

    installQwen(): LocalJob {
      return jobs.start('qwen-code', 'qwen-code', async (handle) => {
        ensureDirs(paths);
        await installQwenCode(paths, handle);
      });
    },

    setKit(provider: 'claude' | 'qwen', mode: KitMode): void {
      updateState(paths, (state) => {
        state.kit[provider] = mode;
      });
    },

    cancel(id: string): void {
      if (!jobs.cancel(id)) throw localError('local-job-unknown', 'такой загрузки нет');
    },

    shutdown(): void {
      jobs.cancelAll();
    },

    logPath: join(paths.logs, 'ollama.log'),
  };
}

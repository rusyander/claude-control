import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_MIN_CONTEXT,
  deviceGpu,
  fitModel,
  gpuTableSchema,
  modelCatalogSchema,
  heldVramBytes,
  recommendModel,
  withOwnHeldVram,
  type CatalogModel,
  type HardwareInfo,
  type InstalledModel,
  type KitMode,
  type KvCacheType,
  type LocalClaudeInfo,
  type LocalDevice,
  type LocalJob,
  type LocalModelsInfo,
  type LocalRuntimeInfo,
  type LocalServerInfo,
  type ModelBench,
  type ModelCatalog,
  type ModelFit,
} from '@agentdeck/contracts/local-models';
import {
  claudeSwitchEnv,
  claudeSwitchPicker,
  describeClaudeSwitch,
  switchClaudeOff,
  switchClaudeOn,
} from './claude-switch.ts';
import { connectLocal, describeConnect, disconnectLocal, type Inject } from './connect.ts';
import { localError } from './errors.ts';
import { detectHardware, type RunCommand } from './hardware.ts';
import { type JobHandle, LocalJobs } from './jobs.ts';
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

/** Что задаётся всему серверу моделей сразу: окно контекста и тип его кеша. */
interface ServerShape {
  context: number;
  kvCache: KvCacheType;
}

function shapeOf(fit: ModelFit): ServerShape {
  return { context: fit.context, kvCache: fit.kvCache ?? 'q8_0' };
}

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
  /**
   * settings.json Claude для переключателя «Claude Code на локальной модели» и
   * каталог копий. Функциями: каталог конфигурации меняется на лету.
   */
  claude?: { settingsPath: () => string; backupDir: () => string | undefined };
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
    if (!force && hardware && Date.now() - hardware.at < HARDWARE_TTL_MS)
      return creditOwnModels(hardware.value);
    const value = await detectHardware({
      table,
      platform: os,
      root: deps.appRoot,
      ...(deps.run ? { run: deps.run } : {}),
    });
    hardware = { at: Date.now(), value };
    return creditOwnModels(value);
  }

  /**
   * Свободная память карты плюс то, что держит наш же сервер: модель, загруженная
   * им, при перезапуске сервера освободится, значит, подбору она не помеха.
   */
  async function creditOwnModels(value: HardwareInfo): Promise<HardwareInfo> {
    const [gpu, ...rest] = value.gpus;
    if (!gpu || (await probe(port, fetchImpl)) === undefined) return value;
    let held: number;
    try {
      const loaded = (await client.ps()).map((model) => ({
        tag: model.name,
        vramBytes: model.size_vram,
        sizeBytes: model.size,
      }));
      const record = readRecord(paths);
      held = heldVramBytes(loaded, catalog.models, record?.context ?? 0, record?.kvCache ?? 'q8_0');
    } catch {
      return value;
    }
    return held > 0 ? { ...value, gpus: [withOwnHeldVram(gpu, held), ...rest] } : value;
  }

  function device(): LocalDevice {
    return readState(paths).device;
  }

  function runtimeBinary(): { source: LocalRuntimeInfo['source']; binary: string; system: string } {
    const system = findSystemBinary(os, env);
    const panel = findPanelBinary(paths, os);
    const picked = pickRuntime(system, panel, readState(paths).preferPanelRuntime);
    return { ...picked, system };
  }

  async function provisionRuntime(handle: JobHandle): Promise<void> {
    const hw = await readHardware();
    ensureDirs(paths);
    await installPanelRuntime({ paths, os, cpu: arch(), gpus: hw.gpus, handle, fetchImpl });
    // Своя сборка поставлена панелью — ею и пользоваться, даже если в системе
    // найдётся другая.
    updateState(paths, (state) => {
      state.preferPanelRuntime = true;
    });
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
      device: version !== undefined && record ? (record.device ?? 'gpu') : device(),
      ...(version !== undefined && record ? { kvCache: record.kvCache ?? 'q8_0' } : {}),
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
          sizeBytes: model.size,
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

  /** Контекст и кеш, с которыми модель встанет на эту карту; чужая модель — агентский минимум. */
  async function contextFor(tag: string): Promise<ServerShape> {
    const hw = await readHardware(true);
    const model = catalogModel(tag);
    if (!model) return { context: AGENT_MIN_CONTEXT, kvCache: 'q8_0' };
    return shapeOf(fitModel(model, deviceGpu(hw, device()), hw.ramGb));
  }

  async function recommendedContext(): Promise<ServerShape> {
    const hw = await readHardware();
    const best = recommendModel(catalog.models, deviceGpu(hw, device()), hw.ramGb);
    return best ? shapeOf(best.fit) : { context: AGENT_MIN_CONTEXT, kvCache: 'q8_0' };
  }

  /** С чем поднят идущий сервер — чтобы скачивание и замер его не перезапускали. */
  function runningShape(): ServerShape | undefined {
    const record = readRecord(paths);
    return record?.context
      ? { context: record.context, kvCache: record.kvCache ?? 'q8_0' }
      : undefined;
  }

  /**
   * Поднять сервер с нужным контекстом и кешем. Оба задаются на весь сервер,
   * поэтому другой контекст или кеш = перезапуск; те же — сервер подхватывается как есть.
   */
  async function ensureServer({ context, kvCache }: ServerShape): Promise<void> {
    const record = readRecord(paths);
    const running = (await probe(port, fetchImpl)) !== undefined;
    const wanted = device();
    if (
      running &&
      record &&
      record.context === context &&
      (record.kvCache ?? 'q8_0') === kvCache &&
      (record.device ?? 'gpu') === wanted
    )
      return;
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
      device: wanted,
      kvCache,
      fetchImpl,
      ...(deps.spawnServer ? { spawnImpl: deps.spawnServer } : {}),
    });
    if (started.version)
      updateState(paths, (state) => {
        state.versions[binary] = started.version;
      });
    // Окно контекста Claude — окно сервера: сервер поднялся с другим, значит, и
    // включённый Claude Code должен сжимать историю по новому.
    const claude = readState(paths).claude;
    if (claude) writeClaude(claude.model, context);
  }

  function writeClaude(model: string, context: number): void {
    if (!deps.claude) return;
    const record = switchClaudeOn({
      settingsPath: deps.claude.settingsPath(),
      model,
      vars: claudeSwitchEnv({ baseUrl: baseUrlOf(port), model, context }),
      picker: claudeSwitchPicker({
        model,
        title: catalogModel(model)?.title ?? model,
        baseUrl: baseUrlOf(port),
      }),
      current: readState(paths).claude,
      backupDir: deps.claude.backupDir(),
    });
    updateState(paths, (state) => {
      state.claude = record;
    });
  }

  function describeClaude(): LocalClaudeInfo {
    return describeClaudeSwitch(readState(paths).claude, deps.claude?.settingsPath() ?? '');
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
        device: state.device,
        claude: describeClaude(),
        qwenCode: describeQwenCode(paths, env),
        kit: state.kit,
        diskUsedBytes: await dirSize(paths.root),
      };
    },

    describeConnect,

    refreshHardware: () => readHardware(true),

    installRuntime(): LocalJob {
      return jobs.start('runtime', 'ollama', provisionRuntime);
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
        // Одна кнопка на чистой машине: сервера моделей нет — ставим свой в той
        // же работе, иначе «Скачать и подключить» падала бы на первом шаге.
        if (!runtimeBinary().binary) await provisionRuntime(handle);
        handle.progress({ phase: 'server' });
        // Скачиванию контекст безразличен: идущий сервер не перезапускаем ради
        // него (это выгрузило бы модель, с которой сейчас работает агент).
        await ensureServer(runningShape() ?? (await contextFor(tag)));
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
      await ensureServer(runningShape() ?? (await contextFor(tag)));
      const hw = await readHardware();
      // Замер на процессоре — не замер карты: иначе каталог в режиме «процессор»
      // показывал бы 98 ток/с видеокарты рядом с оценкой 3–5.
      const where = device();
      const result = {
        ...benchOf(await client.bench(tag), where === 'cpu' ? 'cpu' : (hw.gpus[0]?.name ?? 'cpu')),
        device: where,
      };
      updateState(paths, (state) => {
        state.bench[tag] = result;
      });
      return result;
    },

    connect,

    disconnect: (inject: Inject) => disconnectLocal(inject),

    /**
     * Где считать. Идущий сервер перезапускается сразу: устройство задаётся
     * всему серверу, и выбор, вступающий в силу «когда-нибудь», человек не
     * отличит от несработавшего.
     */
    async setDevice(next: LocalDevice): Promise<LocalServerInfo> {
      updateState(paths, (state) => {
        state.device = next;
      });
      if ((await probe(port, fetchImpl)) !== undefined) {
        const tag = readState(paths).claude?.model ?? (await client.ps())[0]?.name;
        await ensureServer(tag ? await contextFor(tag) : await recommendedContext());
      }
      return describeServer();
    },

    /**
     * «Claude Code на локальной модели». Включение поднимает сервер (иначе первый
     * же сеанс Claude упал бы отказом соединения) и пишет settings.json;
     * выключение возвращает прежнее и сервер не трогает — им пользуются агенты.
     */
    async setClaude(on: boolean, tag?: string): Promise<LocalClaudeInfo> {
      if (!deps.claude) throw localError('local-server-down', 'переключатель Claude недоступен');
      if (!on) {
        const record = readState(paths).claude;
        if (record) switchClaudeOff(record, deps.claude.backupDir());
        updateState(paths, (state) => {
          delete state.claude;
        });
        return describeClaude();
      }
      const model = tag ?? readState(paths).claude?.model ?? '';
      const own = await listStoredModels(paths.models);
      if (!model || !own.some((item) => item.tag === model))
        throw localError('local-model-missing', `модель ${model || '—'} не скачана`, {
          tag: model || '—',
        });
      const shape = await contextFor(model);
      await ensureServer(shape);
      writeClaude(model, readRecord(paths)?.context ?? shape.context);
      return describeClaude();
    },

    /** Claude уведён переключателем — для маршрутизации контура. */
    claudeRedirected: (): boolean => Boolean(readState(paths).claude),

    /** На какую модель уведён Claude и как её подписать; выключено — нет. */
    claudeModel: (): { model: string; title: string } | undefined => {
      const claude = readState(paths).claude;
      return claude
        ? { model: claude.model, title: catalogModel(claude.model)?.title ?? claude.model }
        : undefined;
    },

    /**
     * После перезапуска панели: включённому Claude нужен живой сервер, иначе
     * первый сеанс в терминале получит отказ соединения.
     */
    async resume(): Promise<void> {
      const claude = readState(paths).claude;
      if (claude) await ensureServer(await contextFor(claude.model));
    },

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

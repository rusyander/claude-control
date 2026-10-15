import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_MIN_CONTEXT,
  GPU_RESERVE_GB,
  catalogModelSchema,
  contextStepsFor,
  deviceGpu,
  fitChoice,
  fitModel,
  gpuTableSchema,
  heldVramBytes,
  layerNeedContext,
  modelCatalogSchema,
  LOCAL_REPLY_RESERVE_TOKENS,
  modelNeedGb,
  resolveChoice,
  usableVramGb,
  withInstalledQuant,
  withOwnHeldVram,
  type CatalogModel,
  type HardwareInfo,
  type InstalledModel,
  type KitMode,
  type KvCacheType,
  type LocalActivity,
  type LocalChoiceBody,
  type LocalChoiceResult,
  type LocalClaudeInfo,
  type LocalDevice,
  type LocalIdleMinutes,
  type LocalJob,
  type LocalLayerFit,
  type LocalModelBody,
  type LocalModelsInfo,
  type LocalQuantRow,
  type LocalQuantsInfo,
  type LocalRemoveResult,
  type LocalRuntimeInfo,
  type LocalServerInfo,
  type ModelBench,
  type ModelCatalog,
  type ModelChoiceInfo,
} from '@agentdeck/contracts/local-models';
import {
  claudeSwitchEnv,
  claudeSwitchPicker,
  describeClaudeSwitch,
  readSwitchEnv,
  switchClaudeOff,
  switchClaudeOn,
} from './claude-switch.ts';
import {
  connectLocal,
  describeConnect,
  disconnectLocal,
  saveLocalContour,
  switchLocalOn,
  type Inject,
} from './connect.ts';
import { buildCustomModel, parseRepoInput } from './custom.ts';
import type { FetchLike } from './download.ts';
import { codeOf } from '../../lib/server-text/server-text.ts';
import { localError } from './errors.ts';
import { quantNameOf, readGgufFacts, readGgufWeightType } from './gguf.ts';
import { detectHardware, runCommand, type RunCommand } from './hardware.ts';
import { SPILL_BYTES, processVram, type ProcessVram } from './process-vram.ts';
import { createSlotStore } from './slot-store.ts';
import { downloadModelFile, listRepoFiles, modelFilePath, quantsOf, type RepoQuant } from './hf.ts';
import { type JobHandle, LocalJobs } from './jobs.ts';
import { killProcessTree } from '../../lib/kill-tree.mjs';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { pidAlive } from './hidden-launch.ts';
import { llamaClient } from './llama-client.ts';
import { MAX_RESTARTS, createServerSupervisor, type ReviveResult } from './supervisor.ts';
import { createActivityWatch, type ActivityTrack } from './activity.ts';
import { importOllamaModel } from './ollama-import.ts';
import { LOCAL_GATEWAY_RUN_ENV, localRunEnv } from './run-env.ts';
import { createLocalMcp } from './mcp-service.ts';
import { freesBytes, insideDir, pruneEmptyDirs, removeCounted, samePath } from './remove.ts';
import type { LocalMcpSource } from './local-mcp.ts';
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
  assetsFor,
  detectCudaVersion,
  envBinary,
  fetchRelease,
  findPanelBinary,
  installPanelRuntime,
  isOutdated,
  loadRelease,
  panelRuntimeTag,
  pickRuntime,
} from './runtime.ts';
import {
  baseUrlOf,
  lastErrorLine,
  probe,
  readRecord,
  sameShape,
  startServer,
  stopServer,
  testLoadModel,
  type Offload,
  type ServerRecord,
  type ServerShape,
} from './server.ts';
import {
  dirSize,
  dropUnreferencedBlobs,
  listStoredModels,
  manifestPathOf,
  systemModelsDir,
} from './store.ts';

/**
 * Раздел «Локальные модели» одним объектом: живёт дольше запроса (работы с
 * прогрессом, кеш железа) и гасится при выходе панели.
 *
 * Сервер моделей при выходе НЕ останавливается: он отдельный процесс, и
 * перезапуск панели подхватывает его по записи `run/llama.json`. «Остановить»
 * на странице снимает процесс и тем возвращает видеопамять.
 *
 * Имя модели для людей, контура и замеров — `tag` каталога (`qwen3.6:27b-coding`);
 * файл же определяется выбором: какое квантование скачано и какое выбрано.
 */

const DATA = new URL('./data/', import.meta.url);
/** Железо меряется не на каждый опрос страницы: `nvidia-smi` и PowerShell — сотни миллисекунд. */
const HARDWARE_TTL_MS = 15_000;
const BYTES_PER_GB = 1024 ** 3;
/** Как часто проверять, не пора ли сохранить кеш слота перед сном (L8). */
const IDLE_SAVE_CHECK_MS = 15_000;
/** За сколько до сна по простою сохранять: запись 2–13 ГБ идёт секунды, сон их не ждёт. */
const IDLE_SAVE_LEAD_MS = 45_000;
/** Как часто убирать устаревшие файлы кеша слота, пока панель работает (L8). */
const SLOT_SWEEP_EVERY_MS = 60 * 60_000;

/** Аргумент `--sleep-idle-seconds`: 0 — модель держится загруженной. */
function idleSecondsOf(state: { keepLoaded: boolean; idleMinutes: LocalIdleMinutes }): number {
  return state.keepLoaded ? 0 : state.idleMinutes * 60;
}
const RELEASE_TTL_MS = 60 * 60_000;
const QUANTS_TTL_MS = 10 * 60_000;
/** Метка квантования у модели, пришедшей из хранилища Ollama: какое оно, там не записано. */
export const OLLAMA_QUANT = 'Ollama';

/**
 * Какое квантование у забранного из Ollama файла: `general.file_type` в заголовке GGUF, а когда
 * ключа нет (Ollama его выбрасывает) — основной тип весов по таблице тензоров. Читается раз на
 * файл, а не на каждый опрос страницы. Не определилось — `undefined`, и экран пишет «неизвестное
 * квантование»: слово «Ollama» квантованием не называется.
 */
const labelCache = new Map<string, string | undefined>();
function importedQuantLabel(path: string, size: number): string | undefined {
  const key = `${path}:${size}`;
  if (!labelCache.has(key))
    labelCache.set(key, quantNameOf(readGgufFacts(path)?.fileType) ?? readGgufWeightType(path));
  return labelCache.get(key);
}

export function loadCatalog(): ModelCatalog {
  return modelCatalogSchema.parse(
    JSON.parse(readFileSync(new URL('catalog.json', DATA), 'utf8')) as unknown,
  );
}

/** Путь к своему шаблону чата из каталога: имя проверено схемой, выйти из папки оно не может. */
export function templatePath(name: string): string {
  return fileURLToPath(new URL(`templates/${name}`, DATA));
}

/** С какого запуска снят кеш слота: файл модели, окно, тип кеша, шаблон — иное не прочтётся. */
export function slotShapeOf(record: ServerShape): string {
  return [record.file, record.context, record.kvCache, record.templateHash ?? ''].join('|');
}

/** Отпечаток содержимого шаблона: сменился файл — другой запуск (`sameShape`), а не тот же путь. */
export function templateHashOf(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

function templateOf(name: string): { templateFile: string; templateHash?: string } {
  const templateFile = templatePath(name);
  const templateHash = templateHashOf(templateFile);
  return { templateFile, ...(templateHash ? { templateHash } : {}) };
}

export function loadGpuTable(): ReturnType<typeof gpuTableSchema.parse> {
  return gpuTableSchema.parse(
    JSON.parse(readFileSync(new URL('gpus.json', DATA), 'utf8')) as unknown,
  );
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
    // Не для показа как есть: промпт замера — ~50 токенов, его чтение — накладные
    // расходы, а не скорость чтения. Настоящая видна по первому ходу Claude Code:
    // тысячи токенов за секунды (замер 13.10: 7770 токенов за 3 с).
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
  /** Подмена снятия процесса сервера для проверок: настоящий `kill` по чужому номеру не нужен. */
  kill?: (pid: number, startedAt: number) => void;
  /** Присмотр за сервером: проверки задают срок тика и подменяют «жив ли процесс». */
  supervise?: { intervalMs?: number; pidAlive?: (pid: number) => boolean };
  /** Опрос сервера, пока запрос чата в пути (`activity.ts`); проверки подставляют свои сроки. */
  activity?: { intervalMs?: number; stallMs?: (device: string) => number; now?: () => number };
  /** Свободная оперативная память, байт, — под неё считается `--cache-ram`; проверки подставляют своё. */
  freeBytes?: () => number;
  /** Откуда MCP-серверы проекта и как их опросить; нет — раздел MCP локального прогона пуст. */
  mcp?: LocalMcpSource;
  /** Подмена пробной загрузки (импорт из Ollama) для проверок. */
  testLoad?: (file: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * settings.json Claude для переключателя «Claude Code на локальной модели» и
   * каталог копий. Функциями: каталог конфигурации меняется на лету.
   */
  claude?: { settingsPath: () => string; backupDir: () => string | undefined };
  /**
   * Идёт ли сейчас прогон на локальной модели. Пока идёт, настройки, которым нужен
   * перезапуск сервера (устройство, «держать загруженной», окно и квантование), только
   * сохраняются: перезапуск посреди ночной задачи убил бы ход, а следующий запрос
   * заново считал бы весь контекст. Перезапуск делает `applyPending`, когда прогонов нет.
   */
  runActive?: () => boolean;
  /** Держит ли панель сейчас запрет на сон ОС — для карточки сервера. */
  awakeHeld?: () => boolean;
  /** Часы подъёма по запросу (пауза между неудачами); проверки подставляют свои. */
  now?: () => number;
}

export type LocalModels = ReturnType<typeof createLocalModels>;

/** Установленный файл модели: что поднимать и что показывать. */
interface ModelFile {
  tag: string;
  quant: string;
  source: 'hf' | 'ollama';
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Настоящее квантование из заголовка GGUF — у файла, чья метка служебная (`Ollama`). */
  quantLabel?: string;
}

/** Окно по умолчанию для модели вне каталога: меньшего агенту не хватит. */
const UNKNOWN_CONTEXT = AGENT_MIN_CONTEXT;
/** Неудачных подъёмов по запросу чата подряд, после которых панель сама больше не поднимает сервер. */
export const ON_DEMAND_MAX = MAX_RESTARTS;
/** Пауза после первой неудачи подъёма по запросу; каждая следующая — вдвое длиннее. */
export const ON_DEMAND_BACKOFF_MS = 30_000;
/** Наибольший слой за это время держится: служебные запросы прогона несут слой меньше основного. */
const LAYER_HOLD_MS = 10 * 60_000;

export function createLocalModels(deps: LocalModelsDeps) {
  const env = deps.env ?? process.env;
  const os = deps.os ?? platform();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const run = deps.run ?? runCommand;
  const port = deps.port ?? LOCAL_SERVER_PORT;
  const paths: LocalPaths = localPaths(deps.appRoot, env);
  const catalog = loadCatalog();
  const table = loadGpuTable().gpus;
  const release = loadRelease();
  const jobs = new LocalJobs();
  const client = llamaClient(baseUrlOf(port), fetchImpl);
  let hardware: { at: number; value: HardwareInfo } | undefined;
  let latest: { at: number; value?: { version: string; sizeBytes: number } } | undefined;
  const quantCache = new Map<string, { at: number; rows: RepoQuant[] }>();

  addQwenToPath(paths, env);

  async function readHardware(force = false): Promise<HardwareInfo> {
    if (!force && hardware && Date.now() - hardware.at < HARDWARE_TTL_MS)
      return creditOwnModels(hardware.value, false);
    const llamaServer = envBinary(env) || findPanelBinary(paths, os);
    const value = await detectHardware({
      table,
      platform: os,
      root: deps.appRoot,
      ...(llamaServer ? { llamaServer } : {}),
      ...(deps.run ? { run: deps.run } : {}),
    });
    hardware = { at: Date.now(), value };
    return creditOwnModels(value, true);
  }

  /** Замер памяти процесса сервера (`process-vram.ts`): с тем же сроком, что и сведения о карте. */
  let ownVram: { at: number; pid: number; value?: ProcessVram } | undefined;
  /**
   * Сервер, замеченный с вытеснением в общую память: его выбор кеша не закрепляется
   * (`shapeFor`), и перезапуск ждёт конца прогонов — подбор по замеру положит меньше.
   */
  let spilledPid: number | undefined;

  async function measureOwn(pid: number, fresh: boolean): Promise<ProcessVram | undefined> {
    if (!fresh && ownVram?.pid === pid && Date.now() - ownVram.at < HARDWARE_TTL_MS)
      return ownVram.value;
    const value = await processVram(run, os, pid);
    ownVram = { at: Date.now(), pid, value };
    return value;
  }

  /**
   * Свободная память карты плюс то, что держит наш же сервер: модель, загруженная
   * им, при перезапуске сервера освободится, значит, подбору она не помеха. Засчитывается
   * замер процесса, а оценка — только когда замера нет: вытесненное в общую память на
   * карте не лежит и при перезапуске её не освободит (L9).
   */
  async function creditOwnModels(value: HardwareInfo, fresh: boolean): Promise<HardwareInfo> {
    const [gpu, ...rest] = value.gpus;
    const record = readRecord(paths);
    if (!gpu || !record || record.device === 'cpu' || (await probe(port, fetchImpl)) !== 'ok')
      return value;
    // Выгруженная по простою модель память не держит — засчитывать нечего.
    if (await isSleeping()) return value;
    const measured = record.pid ? await measureOwn(record.pid, fresh) : undefined;
    if (measured && measured.sharedBytes > SPILL_BYTES) noteSpill(record);
    if (measured) {
      // Свободное — по драйверу, а не по CUDA: под WDDM она считает наш сервер свободным,
      // и зачёт сверху удваивал бы его (`process-vram.ts`).
      const freeGb =
        measured.freeBytes !== undefined
          ? measured.freeBytes / BYTES_PER_GB
          : measured.adapterUsedBytes !== undefined
            ? Math.max(0, gpu.vramGb - measured.adapterUsedBytes / BYTES_PER_GB)
            : gpu.freeGb;
      const base = freeGb === undefined ? gpu : { ...gpu, freeGb };
      return { ...value, gpus: [withOwnHeldVram(base, measured.dedicatedBytes), ...rest] };
    }
    const file = statOf(record.file);
    const held = heldVramBytes(
      [
        {
          tag: record.tag,
          vramBytes: file?.size ?? 0,
          sizeBytes: file?.size ?? 0,
          quant: record.quant,
        },
      ],
      allModels(),
      record.context,
      record.kvCache,
    );
    return held > 0 ? { ...value, gpus: [withOwnHeldVram(gpu, held), ...rest] } : value;
  }

  function statOf(path: string): { size: number; mtime: Date } | undefined {
    try {
      const info = statSync(path);
      return { size: info.size, mtime: info.mtime };
    } catch {
      return undefined;
    }
  }

  function device(): LocalDevice {
    return readState(paths).device;
  }

  function runtimeBinary(): { source: LocalRuntimeInfo['source']; binary: string; system: string } {
    const override = envBinary(env);
    const picked = pickRuntime(override, findPanelBinary(paths, os));
    return { ...picked, system: override };
  }

  async function provisionRuntime(handle: JobHandle): Promise<void> {
    const hw = await readHardware();
    ensureDirs(paths);
    const cuda = hw.gpus.some((gpu) => gpu.vendor === 'nvidia')
      ? await detectCudaVersion(run)
      : undefined;
    await installPanelRuntime({
      paths,
      os,
      cpu: arch(),
      gpus: hw.gpus,
      ...(cuda ? { cuda } : {}),
      release,
      handle,
      fetchImpl,
    });
  }

  async function latestRelease(): Promise<{ version: string; sizeBytes: number } | undefined> {
    if (latest && Date.now() - latest.at < RELEASE_TTL_MS) return latest.value;
    try {
      const info = await fetchRelease(release, fetchImpl);
      const hw = await readHardware();
      const cuda = hw.gpus.some((gpu) => gpu.vendor === 'nvidia')
        ? await detectCudaVersion(run)
        : undefined;
      const names = new Set(assetsFor(release.tag, os, arch(), hw.gpus, cuda).map((a) => a.name));
      latest = {
        at: Date.now(),
        value: {
          version: info.tag,
          sizeBytes: info.assets
            .filter((asset) => names.has(asset.name))
            .reduce((sum, asset) => sum + asset.size, 0),
        },
      };
    } catch {
      // Нет сети — кнопка «Скачать» всё равно есть, размер узнается при загрузке.
      latest = { at: Date.now() };
    }
    return latest.value;
  }

  async function describeRuntime(): Promise<LocalRuntimeInfo> {
    const { source, binary, system } = runtimeBinary();
    const version = source === 'panel' ? panelRuntimeTag(binary) : '';
    const info = source === 'none' ? await latestRelease() : undefined;
    return {
      source,
      binary,
      version,
      outdated: isOutdated(version),
      systemBinary: system,
      ...(info ? { latest: info } : {}),
    };
  }

  // ── Файлы моделей ──────────────────────────────────────────────────────

  /** Все установленные файлы одной модели (квантование → файл). */
  function filesOf(tag: string): ModelFile[] {
    const found: ModelFile[] = [];
    const model = catalogModel(tag);
    for (const quant of model?.quants ?? []) {
      const path = modelFilePath(paths, model?.repo ?? '', quant.file);
      const info = statOf(path);
      if (info && info.size === quant.sizeBytes)
        found.push({
          tag,
          quant: quant.id,
          source: 'hf',
          path,
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      // Размер не сошёлся с каталогом, но файл целый (репозиторий обновили): берём по факту,
      // если рядом нет недокачанного хвоста.
      else if (info && !existsSync(`${path}.part`))
        found.push({
          tag,
          quant: quant.id,
          source: 'hf',
          path,
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
    }
    const imported = readState(paths).imported[tag];
    if (imported) {
      const path = join(paths.models, imported.file);
      const info = statOf(path);
      if (info)
        found.push({
          tag,
          quant: OLLAMA_QUANT,
          source: 'ollama',
          path,
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          ...(importedQuantLabel(path, info.size)
            ? { quantLabel: importedQuantLabel(path, info.size) }
            : {}),
        });
    }
    return found;
  }

  /** Файл, с которым модель поднимется: названное квантование, выбор человека, иначе лучший из имеющихся. */
  function activeFile(tag: string, wanted?: string): ModelFile | undefined {
    const files = filesOf(tag);
    const choice = wanted ?? readState(paths).choices[tag]?.quant;
    const model = catalogModel(tag);
    return (
      files.find((file) => file.quant === choice) ??
      files.find((file) => file.quant === OLLAMA_QUANT) ??
      files.find((file) => file.quant === model?.defaultQuant) ??
      [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
    );
  }

  /** Теги всех моделей с файлом: каталог и то, что пришло из Ollama вне каталога. */
  function installedTags(): string[] {
    const tags = new Set<string>();
    for (const model of allModels()) if (filesOf(model.tag).length > 0) tags.add(model.tag);
    for (const tag of Object.keys(readState(paths).imported))
      if (filesOf(tag).length > 0) tags.add(tag);
    return [...tags];
  }

  function installed(): InstalledModel[] {
    const state = readState(paths);
    return installedTags()
      .map((tag): InstalledModel | undefined => {
        const active = activeFile(tag);
        if (!active) return undefined;
        const bench = state.bench[tag];
        return {
          tag,
          sizeBytes: active.sizeBytes,
          modifiedAt: active.modifiedAt,
          known: Boolean(catalogModel(tag)),
          quant: active.quant,
          ...(active.quantLabel ? { quantLabel: active.quantLabel } : {}),
          source: active.source,
          quants: filesOf(tag).map((file) => file.quant),
          files: filesOf(tag).map((file) => ({
            quant: file.quant,
            ...(file.quantLabel ? { quantLabel: file.quantLabel } : {}),
            source: file.source,
            sizeBytes: file.sizeBytes,
            freesBytes: freesBytes(file.path),
          })),
          ...(bench ? { bench } : {}),
        };
      })
      .filter((item): item is InstalledModel => Boolean(item))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }

  function catalogModel(tag: string): CatalogModel | undefined {
    return (
      catalog.models.find((model) => model.tag === tag) ??
      customModels().find((model) => model.tag === tag)
    );
  }

  /**
   * Модели, добавленные по имени репозитория. Агентность — по пробе при
   * подключении: не проверена — считается агентом «с оговоркой», не прошла — нет.
   */
  function customModels(): CatalogModel[] {
    const state = readState(paths);
    const out: CatalogModel[] = [];
    for (const [tag, raw] of Object.entries(state.custom)) {
      const probe = state.tools[tag] ?? 'unknown';
      const parsed = catalogModelSchema.safeParse({ ...raw, toolsProbe: probe });
      if (parsed.success) out.push({ ...parsed.data, agentic: probe !== 'failed' });
    }
    return out;
  }

  /** Каталог панели и добавленное человеком: порядок каталога сохраняется, свои — в конце. */
  function allModels(): CatalogModel[] {
    return [...catalog.models, ...customModels()];
  }

  /** Хранилища Ollama, откуда можно забрать слой: прежнее собственное панели и системное. */
  function ollamaStores(): string[] {
    const system = systemModelsDir(env);
    return system === paths.models ? [paths.models] : [paths.models, system];
  }

  async function importable(): Promise<{ tag: string; sizeBytes: number }[]> {
    const state = readState(paths);
    const out = new Map<string, number>();
    for (const store of ollamaStores()) {
      for (const model of await listStoredModels(store)) {
        if (filesOf(model.tag).length > 0 || state.importFailed[model.tag]) continue;
        if (!out.has(model.tag)) out.set(model.tag, model.sizeBytes);
      }
    }
    return [...out]
      .map(([tag, sizeBytes]) => ({ tag, sizeBytes }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }

  // ── Запуск сервера ─────────────────────────────────────────────────────

  async function gpuFor(): Promise<{ hw: HardwareInfo; gpu: ReturnType<typeof deviceGpu> }> {
    const hw = await readHardware(true);
    return { hw, gpu: deviceGpu(hw, device()) };
  }

  /**
   * Как поднять модель: названное человеком (в запросе или запомненное) бьёт
   * подбор, не названное подбирается под эту карту. Куда класть слои считается
   * по тому, что окно и кеш в итоге требуют, а не по подбору: человек мог
   * выбрать окно больше того, что лёг бы без него.
   */
  async function shapeFor(body: { tag: string } & Partial<LocalModelBody>): Promise<ServerShape> {
    const { tag } = body;
    const file = activeFile(tag, body.quant);
    if (!file || (body.quant && file.quant !== body.quant))
      throw localError('local-model-missing', `модель ${tag} не скачана`, { tag });
    const choice = readState(paths).choices[tag] ?? {};
    const known = catalogModel(tag);
    const model = known ? withInstalledQuant(known, file) : undefined;
    const { hw, gpu } = await gpuFor();
    const fit = model ? fitModel(model, gpu, hw.ramGb, file.quant) : undefined;
    const context = body.context ?? choice.context ?? fit?.context ?? UNKNOWN_CONTEXT;
    if (model && context > model.contextMax)
      throw localError(
        'local-context-range',
        `окно ${context} больше предела модели ${model.contextMax}`,
        { min: 2048, max: model.contextMax },
      );
    // Идущий сервер этой же модели с тем же окном, чей кеш выбрал подбор, — его выбор
    // остаётся (`ServerShape.fitted`): подбор при живом сервере видит память иначе.
    const named = body.kvCache ?? choice.kvCache;
    const running = readRecord(paths);
    const sticky =
      !named &&
      running?.fitted === true &&
      running.pid !== spilledPid &&
      running.tag === tag &&
      running.file === file.path &&
      running.context === context &&
      running.device === device()
        ? running
        : undefined;
    // Тип кеша — под ВЫБРАННОЕ окно, а не под подобранное: человек мог взять окно
    // больше того, что лёг бы без выбора, и q8_0 тогда не влезет, а q4_0 — да.
    const kvCache: KvCacheType =
      named ??
      sticky?.kvCache ??
      (model ? fitChoice(model, gpu, hw.ramGb, { quant: file.quant, context }).kvCache : 'q8_0');
    const facts = readGgufFacts(file.path);
    let offload: Offload = 'fit';
    if (device() === 'cpu' || !gpu) offload = 'none';
    else if (sticky) offload = sticky.offload;
    else if (
      model &&
      modelNeedGb(model, context, kvCache, file.quant) + GPU_RESERVE_GB <= usableVramGb(gpu)
    )
      offload = 'all';
    return {
      ...(named ? {} : { fitted: true }),
      tag,
      file: file.path,
      quant: file.quant,
      context,
      kvCache,
      device: device(),
      mtp: (facts?.nextn ?? 0) > 0,
      offload,
      idleSeconds: idleSecondsOf(readState(paths)),
      recurrent: facts?.recurrent ?? false,
      ...(model?.chatTemplateKwargs
        ? { templateKwargs: JSON.stringify(model.chatTemplateKwargs) }
        : {}),
      ...(model?.chatTemplate ? templateOf(model.chatTemplate) : {}),
    };
  }

  /** Запомнить то, что человек назвал явно: следующий запуск поднимется так же. */
  function rememberChoice(body: { tag: string } & Partial<LocalModelBody>): void {
    if (!body.quant && !body.context && !body.kvCache) return;
    updateState(paths, (state) => {
      const next = { ...(state.choices[body.tag] ?? {}) };
      if (body.quant) next.quant = body.quant;
      if (body.context) next.context = body.context;
      if (body.kvCache) next.kvCache = body.kvCache;
      state.choices[body.tag] = next;
    });
  }

  /**
   * Поднять сервер. Модель, окно, тип кеша, устройство и MTP — аргументы запуска,
   * поэтому любое изменение = перезапуск; тот же запуск — сервер подхватывается как есть.
   */
  /** Сколько запусков и остановок сервера панель ведёт сейчас: присмотр в это время молчит. */
  /** Настройка сохранена, а перезапуск сервера ждёт конца прогона. Хранится в файле состояния: переживает перезапуск панели. */
  let pendingRestart = readState(paths).pendingRestart === true;
  // Шаблон чата идущего сервера сменился с обновлением панели (L7: пометка отложенных
  // инструментов): сервер держит прежний, пока его не перезапустят, а шлюз уже шлёт
  // тела под новый. Перезапуск — как у отложенной настройки, когда прогонов нет.
  {
    const record = readRecord(paths);
    if (record?.templateFile && record.templateHash !== templateHashOf(record.templateFile))
      pendingRestart = true;
    // Так же со сроком простоя (L8: 600 → 300 с): сервер со старым сроком после записи кеша
    // перед сном держал бы модель в видеопамяти вдвое дольше обещанного.
    const idleSeconds = idleSecondsOf(readState(paths));
    if (record && (record.idleSeconds ?? 0) !== idleSeconds) pendingRestart = true;
  }
  /** Подряд не удавшихся применений отложенной настройки: вторая неудача снимает ожидание. */
  let applyFailures = 0;
  /** Модель, которую не удалось поднять с новой настройкой: после сбоя записи сервера уже нет. */
  let failedTag: string | undefined;
  /** Почему отложенная настройка так и не применилась (после двух попыток); видна на карточке сервера. */
  let restartError: string | undefined;
  /**
   * Сервер не влез в карту (L9): подобранный кеш больше не закрепляется, перезапуск —
   * когда прогонов нет. Названный человеком кеш подбор не меняет, а перезапуск с тем же
   * запуском ничего бы не дал — тогда только снимается закрепление.
   */
  function noteSpill(record: ServerRecord): void {
    if (spilledPid === record.pid) return;
    spilledPid = record.pid;
    if (record.fitted) setPending(true);
  }
  function setPending(value: boolean): void {
    pendingRestart = value;
    if (!value) applyFailures = 0;
    if ((readState(paths).pendingRestart === true) === value) return;
    updateState(paths, (state) => {
      if (value) state.pendingRestart = true;
      else delete state.pendingRestart;
    });
  }
  /**
   * Запуски и остановки сервера идут по одному — очередью, а не счётчиком. Счётчик лишь
   * глушил присмотр, а «Перезапустить» в чате, подъём по запросу чата, «Запустить» и смена
   * выбора на странице шли одновременно: два `startServer` на один порт, и проигравший стирал
   * запись живого сервера — сирота держала порт и видеопамять, а удаление файла модели
   * считало его свободным. Работа под очередью саму очередь не зовёт (`ensureServerNow`).
   */
  let managed = 0;
  let queue: Promise<unknown> = Promise.resolve();
  function managedBy<T>(work: () => Promise<T>): Promise<T> {
    managed += 1;
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run.finally(() => {
      managed -= 1;
    });
  }

  function ensureServer(shape: ServerShape): Promise<void> {
    return managedBy(() => ensureServerNow(shape));
  }

  /** Ждавшая перезапуска настройка действует, если идущий сервер уже поднят по свежему выбору. */
  async function settlePending(): Promise<void> {
    if (!pendingRestart) return;
    const record = readRecord(paths);
    if (!record) {
      setPending(false);
      return;
    }
    try {
      if (sameShape(record, await shapeFor({ tag: record.tag }))) {
        setPending(false);
        restartError = undefined;
      }
    } catch {
      // Модель пропала или не влезает: останется ждать — человек увидит причину при запуске.
    }
  }

  /**
   * Нужен ли перезапуск идущего сервера ОТЛОЖИТЬ: прогон на локальной модели идёт. Отложенное
   * запоминается — карточка сервера пишет «применится после текущего прогона».
   */
  function deferRestart(): boolean {
    if (!deps.runActive?.()) return false;
    setPending(true);
    restartError = undefined;
    return true;
  }

  async function ensureServerNow(shape: ServerShape): Promise<void> {
    const record = readRecord(paths);
    const running = (await probe(port, fetchImpl)) !== undefined;
    if (running && record && sameShape(record, shape)) {
      await settlePending();
      return;
    }
    if (running && record) await stopServer(paths, port, fetchImpl, deps.kill);
    const { binary } = runtimeBinary();
    if (!binary)
      throw localError('local-runtime-missing', 'сервер моделей не установлен — нажмите «Скачать»');
    ensureDirs(paths);
    await startServer({
      paths,
      binary,
      port,
      shape,
      fetchImpl,
      ...(deps.spawnServer ? { spawnImpl: deps.spawnServer } : {}),
      ...(deps.kill ? { kill: deps.kill } : {}),
      ...(deps.freeBytes ? { freeBytes: deps.freeBytes } : {}),
    });
    const started = readRecord(paths);
    if (started) supervisor.observe(started);
    await settlePending();
    // Сервер поднят — прежняя причина неудавшегося перезапуска устарела.
    restartError = undefined;
    // Окно контекста Claude — окно сервера: сервер поднялся с другим, значит, и
    // включённый Claude Code должен сжимать историю по новому.
    const claude = readState(paths).claude;
    if (claude) writeClaude(claude.model, shape.context);
  }

  /**
   * Сервер не запущен и не помнится, а запрос чата на скачанную модель уже пришёл: панель
   * поднимает его сама и держит запрос до готовности (L6, «с первого клика»). Раньше такой
   * запрос получал «Нет связи с контуром», и человек включал и выключал модель, пока сервер
   * не поднимался другим путём. Одновременные запросы ждут один и тот же подъём.
   */
  let onDemand: Promise<ReviveResult> | undefined;
  /**
   * Подъём по запросу ограничен (L6, ревью M1): модель, падающая при загрузке (нехватка
   * видеопамяти на большом окне), не оставляет ни записи, ни цели присмотра, и каждый повтор
   * 529 у Claude Code (а он повторяет бесконечно) грузил 17 ГБ заново — всю ночь. Теперь
   * `MAX_RESTARTS` неудач подряд с паузой 30 с, 60 с между ними, дальше отказ с причиной из
   * журнала, пока человек сам не запустит сервер. Удачный подъём снимает счёт.
   */
  let onDemandFailures = 0;
  let onDemandNextAt = 0;
  let onDemandCause: string | undefined;
  const clock = deps.now ?? Date.now;
  function resetOnDemand(): void {
    onDemandFailures = 0;
    onDemandNextAt = 0;
    onDemandCause = undefined;
  }
  /** Причина неудачи: последняя строка-ошибка журнала этого запуска, иначе прошлого, иначе текст отказа. */
  function crashCause(error: unknown): string {
    const log = paths.serverLog;
    return (
      lastErrorLine([log, log.replace(/\.log$/, '.out.log'), log.replace(/\.log$/, '.prev.log')]) ??
      (error instanceof Error ? error.message : String(error))
    );
  }
  function noteStartFailure(error: unknown): void {
    onDemandFailures += 1;
    onDemandCause = crashCause(error);
    onDemandNextAt =
      onDemandFailures >= ON_DEMAND_MAX
        ? Number.POSITIVE_INFINITY
        : clock() + ON_DEMAND_BACKOFF_MS * 2 ** (onDemandFailures - 1);
  }
  function startOnDemand(tag: string): Promise<ReviveResult> {
    if (readRecord(paths) || supervisor.target()) return supervisor.revive();
    if (onDemandFailures >= ON_DEMAND_MAX || clock() < onDemandNextAt)
      return Promise.resolve('capped');
    onDemand ??= (async (): Promise<ReviveResult> => {
      try {
        await ensureServer(await shapeFor({ tag }));
        // Поднят заново — у присмотра новая эпоха: прежние неудачи ему не в счёт.
        supervisor.reset();
        resetOnDemand();
        return 'restarted';
      } catch (error) {
        noteStartFailure(error);
        return 'failed';
      } finally {
        onDemand = undefined;
      }
    })();
    return onDemand;
  }

  /**
   * Окно, с которым поднимется сервер этой модели, — до того, как он поднят. То же правило,
   * что у `shapeFor`: выбор, иначе подбор под эту карту (на 16 ГБ — меньше умолчания каталога).
   * Шлюз по нему считает предел промпта и урезает ответ: окно умолчания вместо подобранного
   * пропускало запрос, который сервер потом отвергал переполнением. Железо — последний замер;
   * его ещё не было — умолчание каталога, и замер заводится на следующий раз.
   */
  function plannedContext(tag: string): number {
    const chosen = readState(paths).choices[tag]?.context;
    if (chosen) return chosen;
    const known = catalogModel(tag);
    const file = activeFile(tag);
    const hw = hardware?.value;
    if (!hw) void readHardware().catch(() => undefined);
    if (known && file && hw)
      return fitModel(
        withInstalledQuant(known, file),
        deviceGpu(hw, device()),
        hw.ramGb,
        file.quant,
      ).context;
    return known?.defaultContext ?? UNKNOWN_CONTEXT;
  }

  /** Что сказать прогону, когда сервер не поднялся: текст ошибки шлюза. */
  function noticeText(): string | undefined {
    if (onDemandFailures > 0 && onDemandCause && !readRecord(paths)) {
      if (onDemandFailures >= ON_DEMAND_MAX)
        return serverText('local-on-demand-failed', {
          attempts: onDemandFailures,
          cause: onDemandCause,
        });
      return serverText('local-on-demand-backoff', {
        attempts: onDemandFailures,
        max: ON_DEMAND_MAX,
        cause: onDemandCause,
        seconds: Math.max(0, Math.ceil((onDemandNextAt - clock()) / 1_000)),
      });
    }
    const notice = supervisor.notice();
    if (!notice || notice.kind === 'restarted') return undefined;
    const said = serverText('local-supervisor-gave-up', { restarts: notice.restarts });
    return notice.reason ? `${said}: ${notice.reason}` : said;
  }

  // Присмотр: умерший сервер поднимается по записи, пока человек его не остановил.
  const supervisor = createServerSupervisor({
    record: () => readRecord(paths),
    health: () => probe(port, fetchImpl),
    pidAlive: deps.supervise?.pidAlive ?? pidAlive,
    kill: (record) => {
      (deps.kill ?? ((pid, startedAt) => killProcessTree(pid, { spawnedAt: startedAt })))(
        record.pid,
        record.startedAt,
      );
    },
    restart: async (record, control) => {
      // Снятый зависший процесс отпускает порт не сразу.
      const alive = deps.supervise?.pidAlive ?? pidAlive;
      for (let waited = 0; waited < 5_000 && alive(record.pid); waited += 250)
        await new Promise((resolve) => setTimeout(resolve, 250));
      // Человек нажал «Стоп», пока ждали порт: поднимать сервер, который он остановил, нельзя.
      if (control.cancelled()) return;
      // Сервер, упавший, пока ждёт перезапуска настройка, поднимается уже с ней, а не со старой записью.
      const fresh = pendingRestart
        ? await shapeFor({ tag: record.tag }).catch(() => record)
        : record;
      await ensureServer(fresh);
    },
    busy: () => managed > 0,
    ...(deps.supervise?.intervalMs ? { intervalMs: deps.supervise.intervalMs } : {}),
  });

  /**
   * Перезапуск сервера теми же параметрами: слот застыл посреди разбора при живом
   * `/health` (L6) или человек нажал «Перезапустить» в чате. Присмотр молчит, пока идёт.
   */
  async function restartServerNow(): Promise<void> {
    await managedBy(async () => {
      // Запись читается в очереди: пока ждали, сервер могли остановить или поднять иначе.
      const record = readRecord(paths) ?? supervisor.target();
      if (!record) return;
      await stopServer(paths, port, fetchImpl, deps.kill);
      await ensureServerNow(record);
    });
  }

  // Что сервер делает с запросом чата: живость вместо срока ожидания (L6, `activity.ts`).
  const activity = createActivityWatch({
    health: () => probe(port, fetchImpl),
    slot: () => client.slot(0),
    server: () => {
      const record = readRecord(paths) ?? supervisor.target();
      return record
        ? { model: record.tag, quant: record.quant, context: record.context, device: record.device }
        : undefined;
    },
    onWedged: () => void restartServerNow().catch(() => undefined),
    stallText: (seconds) => serverText('local-stalled', { seconds }),
    ...deps.activity,
  });

  // ── Слой прогона против окна (L6, ревью B1) ────────────────────────────

  /**
   * Шлюз меряет слой (системный промпт и инструменты) на каждом запросе с инструментами.
   * Держится наибольший за `LAYER_HOLD_MS`: подагенты и служебные запросы несут слой меньше
   * основного и иначе прятали бы его. В файл состояния — только когда изменился заметно:
   * страница показывает его и до первого хода после перезапуска панели.
   */
  function noteLayer(tag: string, tokens: number): void {
    const at = clock();
    const stored = readState(paths).layers[tag];
    if (stored && tokens < stored.tokens && at - stored.at < LAYER_HOLD_MS) return;
    if (stored && Math.abs(stored.tokens - tokens) < 512 && at - stored.at < LAYER_HOLD_MS) return;
    updateState(paths, (state) => {
      state.layers[tag] = { tokens, at };
    });
  }

  /** Чем починить слой, который не влезает: окно, а если нынешнее квантование его не вынесет — и квантование. */
  async function layerFix(tag: string, tokens: number): Promise<LocalLayerFit['fix']> {
    const need = layerNeedContext(tokens);
    const known = catalogModel(tag);
    if (!known) return undefined;
    const file = activeFile(tag);
    const model = withInstalledQuant(known, file);
    const context = contextStepsFor(model).find((step) => step >= need);
    if (context === undefined) return undefined;
    const hw = await readHardware();
    const gpu = deviceGpu(hw, device());
    const current = file?.quant ?? model.defaultQuant;
    const fitsWith = (quant: string): boolean =>
      fitChoice(model, gpu, hw.ramGb, { quant, context }).fits;
    if (fitsWith(current)) return { context };
    const other = [...model.quants]
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .find((quant) => quant.id !== current && fitsWith(quant.id));
    return other ? { context, quant: other.id } : { context };
  }

  /** Слой последней модели против окна её сервера (идущего, иначе того, с которым поднимется). */
  async function layerFit(): Promise<LocalLayerFit | undefined> {
    const record = readRecord(paths) ?? supervisor.target();
    const { layers } = readState(paths);
    // Сервера нет — модель последнего замера: её поднимет первый же запрос чата.
    const tag = record?.tag ?? Object.entries(layers).sort(([, a], [, b]) => b.at - a.at)[0]?.[0];
    const stored = tag ? layers[tag] : undefined;
    if (!tag || !stored || !activeFile(tag)) return undefined;
    const context = record?.context ?? plannedContext(tag);
    const limit = Math.max(0, context - LOCAL_REPLY_RESERVE_TOKENS);
    const fits = layerNeedContext(stored.tokens) <= context;
    const fix = fits ? undefined : await layerFix(tag, stored.tokens).catch(() => undefined);
    return { tokens: stored.tokens, context, limit, fits, at: stored.at, ...(fix ? { fix } : {}) };
  }

  /** Спит ли сервер по простою: `/props` его не будит (замер 14.10); не отвечает — не спит. */
  async function isSleeping(): Promise<boolean> {
    try {
      return (await client.props()).sleeping;
    } catch {
      return false;
    }
  }

  // Кеш прочитанного промпта на диске (L8, `slot-store.ts`).
  const slots = createSlotStore({
    dir: paths.slotsDir,
    client,
    shape: () => {
      const record = readRecord(paths);
      return record ? slotShapeOf(record) : undefined;
    },
    pid: () => readRecord(paths)?.pid,
    sleeping: isSleeping,
    now: clock,
  });
  // Уборка кеша слота при старте панели и раз в час: файл, оставшийся от прошлого запуска или
  // брошенного чата, иначе лежал бы до следующей записи (её может не быть неделями).
  void slots.sweep().catch(() => undefined);
  const slotSweeper = setInterval(
    () => void slots.sweep().catch(() => undefined),
    SLOT_SWEEP_EVERY_MS,
  );
  slotSweeper.unref?.();

  /**
   * Разговор, чей запрос сервер получит сейчас. Сменился — кеш прежнего уходит на диск, а
   * кеш этого поднимается из файла; файла нет — слот стирается: новый чат не наследует чужой
   * префикс. Спящий сервер без файла не будится. Сбой запрос не срывает (`slot-store.ts`).
   */
  async function noteSession(session: string | undefined): Promise<void> {
    ensureIdleSaver();
    try {
      await (session ? slots.switchTo(session) : slots.release());
    } catch {
      // Сервер без каталога слотов (запущен прежней панелью) или занят: запрос идёт как есть.
    }
  }

  /**
   * Перед сном по простою кеш слота — на диск: спящий сервер выгружает модель вместе с
   * кешем, и первый ход после сна читал бы весь промпт заново. Проверка раз в
   * `IDLE_SAVE_CHECK_MS`; запись — за `IDLE_SAVE_LEAD_MS` до сна, один раз до следующего запроса.
   */
  let idleSaver: ReturnType<typeof setInterval> | undefined;
  function ensureIdleSaver(): void {
    if (idleSaver) return;
    idleSaver = setInterval(
      () => void saveBeforeSleep().catch(() => undefined),
      IDLE_SAVE_CHECK_MS,
    );
    idleSaver.unref?.();
  }
  async function saveBeforeSleep(): Promise<void> {
    const record = readRecord(paths);
    const idle = slots.idleMs();
    if (!record?.idleSeconds || idle === undefined || activity.snapshot().inFlight > 0) return;
    const minIdleMs = record.idleSeconds * 1000 - IDLE_SAVE_LEAD_MS;
    if (idle < minIdleMs) return;
    await slots.saveIdle(minIdleMs);
  }

  // MCP-серверы локального прогона. Источника нет (проверки без панели) — раздел пуст.
  const mcp = createLocalMcp({
    source: deps.mcp ?? { list: () => [], tools: () => Promise.reject(new Error('no source')) },
    read: () => readState(paths),
    update: (change) => {
      updateState(paths, change);
    },
    context: () => readRecord(paths)?.context || AGENT_MIN_CONTEXT,
    // Счёт настоящего сервера моделей — только у бодрствующего: запрос будит спящий.
    count: async () => {
      const record = readRecord(paths);
      if (!record || (await probe(port, fetchImpl)) !== 'ok' || (await isSleeping()))
        return undefined;
      const ask = (tools: unknown[]): Promise<number> =>
        client.countTokens({
          model: record.tag,
          messages: [{ role: 'user', content: 'x' }],
          ...(tools.length ? { tools } : {}),
        });
      const empty = await ask([]);
      return async (tools) => Math.max(0, (await ask(tools)) - empty);
    },
  });

  async function describeServer(): Promise<LocalServerInfo> {
    const health = await probe(port, fetchImpl);
    const record = readRecord(paths);
    const running = health === 'ok';
    const state = readState(paths);
    const keepLoaded = state.keepLoaded;
    const sleeping = running && record ? await isSleeping() : false;
    const notice = supervisor.notice();
    const layer = await layerFit();
    const base: LocalServerInfo = {
      ...(notice ? { notice } : {}),
      ...(pendingRestart ? { restartPending: true } : {}),
      ...(restartError ? { restartError } : {}),
      ...(layer ? { layer } : {}),
      keepLoaded,
      keepAwake: readState(paths).keepAwake,
      ...(deps.awakeHeld?.() ? { awake: true } : {}),
      // Срок идущего сервера, а не нынешний по умолчанию: до перезапуска действует прежний.
      idleSeconds:
        (running && record?.idleSeconds) || idleSecondsOf({ ...state, keepLoaded: false }),
      idleMinutes: state.idleMinutes,
      ...(sleeping ? { sleeping } : {}),
      running,
      port,
      baseUrl: baseUrlOf(port),
      loaded: [],
      context: record?.context ?? 0,
      device: running && record ? record.device : device(),
      ...(running && record ? { kvCache: record.kvCache } : {}),
      ...(record?.pid ? { pid: record.pid } : {}),
    };
    if (!running || !record) return base;
    const size = statOf(record.file)?.size ?? 0;
    const model = catalogModel(record.tag);
    const vram =
      record.device === 'cpu'
        ? 0
        : model
          ? Math.round(modelNeedGb(model, record.context, record.kvCache, record.quant) * 1024 ** 3)
          : size;
    return {
      ...base,
      model: record.tag,
      quant: record.quant,
      mtp: record.mtp,
      // Выгруженная по простою модель память не держит: «загружено» пусто, пока запрос её не вернёт.
      loaded: sleeping
        ? []
        : [{ tag: record.tag, vramBytes: vram, sizeBytes: size, until: '', quant: record.quant }],
    };
  }

  // ── Claude Code и контур ───────────────────────────────────────────────

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

  async function connect(
    inject: Inject,
    body: { tag: string } & Partial<LocalModelBody>,
  ): Promise<unknown> {
    const shape = await shapeFor(body);
    rememberChoice(body);
    await ensureServer(shape);
    const activation = await connectLocal(inject, {
      baseUrl: baseUrlOf(port),
      model: body.tag,
      title: catalogModel(body.tag)?.title ?? body.tag,
    });
    rememberToolsProbe(body.tag, activation);
    return activation;
  }

  /**
   * Итог пробы инструментов, которую контур делает при включении: модель вне
   * каталога после неё перестаёт быть «не проверенной». Проба не задавалась
   * (прослойка, свои инструменты контура) — прежняя запись остаётся.
   */
  function rememberToolsProbe(tag: string, activation: unknown): void {
    if (!readState(paths).custom[tag]) return;
    const tools = (activation as { smoke?: { tools?: { ok?: boolean } } } | undefined)?.smoke
      ?.tools;
    if (tools?.ok === undefined) return;
    updateState(paths, (state) => {
      state.tools[tag] = tools.ok ? 'ok' : 'failed';
    });
  }

  // ── Квантования ────────────────────────────────────────────────────────

  async function repoQuants(
    model: CatalogModel,
  ): Promise<{ from: 'hf' | 'catalog'; rows: RepoQuant[] }> {
    const cached = quantCache.get(model.repo);
    if (cached && Date.now() - cached.at < QUANTS_TTL_MS) return { from: 'hf', rows: cached.rows };
    try {
      const rows = quantsOf(await listRepoFiles(model.repo, fetchImpl));
      if (rows.length > 0) {
        quantCache.set(model.repo, { at: Date.now(), rows });
        return { from: 'hf', rows };
      }
    } catch {
      // Нет сети или репозиторий недоступен — снимок каталога.
    }
    return {
      from: 'catalog',
      rows: model.quants.map((quant) => ({ ...quant, sha256: '' })),
    };
  }

  async function quants(tag: string): Promise<LocalQuantsInfo> {
    const model = catalogModel(tag);
    if (!model) throw localError('local-model-unknown', `модели ${tag} нет в каталоге`, { tag });
    const { from, rows } = await repoQuants(model);
    const { hw, gpu } = await gpuFor();
    const files = filesOf(tag);
    const active = activeFile(tag)?.quant;
    const out: LocalQuantRow[] = rows.map((row) => {
      const fit = fitModel(model, gpu, hw.ramGb, row.id);
      return {
        id: row.id,
        file: row.file,
        sizeBytes: row.sizeBytes,
        installed: files.some((file) => file.quant === row.id),
        active: row.id === active,
        fit: {
          level: fit.level,
          context: fit.context,
          ...(fit.kvCache ? { kvCache: fit.kvCache } : {}),
          needGb: fit.needGb,
          tokensPerSec: fit.tokensPerSec,
          agentReady: fit.agentReady,
        },
      };
    });
    return { tag, repo: model.repo, from, defaultQuant: model.defaultQuant, rows: out };
  }

  // ── Выбор квантования и окна ───────────────────────────────────────────

  /**
   * Поднять идущий сервер так, как сейчас выбрано для модели. Пока шёл перезапуск,
   * человек мог выбрать ещё раз, — поэтому после запуска выбор читается заново и,
   * если он ушёл дальше, сервер поднимается ещё раз (не больше трёх).
   */
  async function applyChoice(tag: string): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) {
      await ensureServer(await shapeFor({ tag }));
      const record = readRecord(paths);
      if (record && sameShape(record, await shapeFor({ tag }))) return;
    }
  }

  async function setChoice(body: LocalChoiceBody): Promise<LocalChoiceResult> {
    const known = catalogModel(body.tag);
    if (!known)
      throw localError('local-model-unknown', `модели ${body.tag} нет в каталоге`, {
        tag: body.tag,
      });
    const active = activeFile(body.tag);
    const model = withInstalledQuant(known, active);
    if (body.quant && !model.quants.some((quant) => quant.id === body.quant))
      throw localError(
        'local-quant-unknown',
        `у модели ${body.tag} нет квантования ${body.quant}`,
        {
          tag: body.tag,
          quant: body.quant,
        },
      );
    if (body.context && body.context > model.contextMax)
      throw localError(
        'local-context-range',
        `окно ${body.context} больше предела модели ${model.contextMax}`,
        { min: 2048, max: model.contextMax },
      );
    const { hw, gpu } = await gpuFor();
    const stored = readState(paths).choices[body.tag];
    const next: ModelChoiceInfo = {
      ...stored,
      ...(body.quant ? { quant: body.quant } : {}),
      ...(body.context ? { context: body.context } : {}),
      ...(body.allowPartial === undefined ? {} : { allowPartial: body.allowPartial }),
    };
    // Тип кеша выбирается сам под пару — прежний явный (из запроса) к новой паре не подходит.
    delete next.kvCache;
    const pick = resolveChoice(model, gpu, hw.ramGb, next, active?.quant);
    const fit = fitChoice(model, gpu, hw.ramGb, pick, next.allowPartial);
    if (!fit.allowed)
      throw localError(
        'local-choice-no-fit',
        `${body.tag}: не влезает — нужно ${fit.needGb.toFixed(1)} ГБ, доступно ${fit.availableGb.toFixed(1)} ГБ`,
        {
          tag: body.tag,
          need: Math.round(fit.needGb * 10) / 10,
          available: Math.round(fit.availableGb * 10) / 10,
        },
      );
    // Оба значения запоминаются явно: то, что человек видит в списках, то и поднимется.
    next.quant = pick.quant;
    next.context = pick.context;
    updateState(paths, (state) => {
      state.choices[body.tag] = next;
    });
    // Новый выбор — новая попытка: отказ подъёма по запросу касался прежнего окна или файла.
    resetOnDemand();
    // Идёт именно эта модель, выбрано скачанное квантование и запуск изменился —
    // перезапуск виден работой с этапом «restart». Не скачанное квантование сервер
    // не трогает: страница предлагает его скачать.
    const record = readRecord(paths);
    let restart: LocalJob | undefined;
    if (
      record?.tag === body.tag &&
      filesOf(body.tag).some((file) => file.quant === pick.quant) &&
      (await probe(port, fetchImpl)) !== undefined &&
      !sameShape(record, await shapeFor({ tag: body.tag }))
    ) {
      // Идёт прогон — выбор сохранён, сервер перезапустит `applyPending` по его окончании.
      if (deferRestart()) return { choice: next };
      restart = jobs.start('server', body.tag, async (handle) => {
        handle.progress({ phase: 'restart' });
        await applyChoice(body.tag);
      });
    }
    return { choice: next, ...(restart ? { restart } : {}) };
  }

  // ── «Любая модель» ─────────────────────────────────────────────────────

  async function addCustom(input: string): Promise<CatalogModel> {
    const repo = parseRepoInput(input);
    if (!repo)
      throw localError('local-custom-input', 'назовите репозиторий как «владелец/репозиторий»');
    const same = allModels().find((model) => model.repo.toLowerCase() === repo.toLowerCase());
    if (same) return same;
    const raw = await buildCustomModel(repo, fetchImpl);
    const model = catalogModelSchema.parse(raw);
    updateState(paths, (state) => {
      state.custom[model.tag] = raw;
    });
    quantCache.delete(repo);
    return model;
  }

  // ── Импорт из Ollama ───────────────────────────────────────────────────

  async function importOne(tag: string, handle: JobHandle): Promise<void> {
    if (!runtimeBinary().binary) await provisionRuntime(handle);
    const { binary } = runtimeBinary();
    ensureDirs(paths);
    try {
      const entry = await importOllamaModel({
        paths,
        stores: ollamaStores(),
        tag,
        handle,
        testLoad:
          deps.testLoad ??
          ((file) =>
            testLoadModel({
              binary,
              file,
              fetchImpl,
              ...(deps.spawnServer ? { spawnImpl: deps.spawnServer } : {}),
            })),
      });
      updateState(paths, (state) => {
        state.imported[tag] = entry;
        delete state.importFailed[tag];
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Не открыл именно llama.cpp (а не «не нашли манифест»): запоминаем, чтобы не
      // пробовать при каждом запуске панели, и предлагаем скачать заново.
      if (codeOf(error).messageCode === 'local-load-failed')
        updateState(paths, (state) => {
          state.importFailed[tag] = reason;
        });
      throw error;
    }
  }

  /**
   * Модели из собственного прежнего хранилища панели (скачаны Ollama, пока она
   * была сервером) забираются сами, один раз: человек ждёт, что скачанное
   * осталось. Системное хранилище Ollama так не трогается — оно чужое, его
   * модели забираются кнопкой.
   */
  async function migrateOwnStore(): Promise<void> {
    if (!runtimeBinary().binary) return;
    const state = readState(paths);
    for (const model of await listStoredModels(paths.models)) {
      if (filesOf(model.tag).length > 0 || state.importFailed[model.tag]) continue;
      jobs.start('model', model.tag, (handle) => importOne(model.tag, handle));
    }
  }

  /** Рекомендуемая из скачанных: первая по порядку каталога, что есть на диске. */
  function recommendedTag(): string | undefined {
    const have = new Set(installedTags());
    const best = allModels().find((model) => have.has(model.tag));
    return best?.tag ?? [...have][0];
  }

  return {
    paths,
    jobs,

    async describe(): Promise<LocalModelsInfo> {
      const [hw, runtime, server, canImport] = await Promise.all([
        readHardware(),
        describeRuntime(),
        describeServer(),
        importable(),
      ]);
      const state = readState(paths);
      return {
        root: paths.root,
        hardware: hw,
        runtime,
        server,
        catalog: { ...catalog, models: allModels() },
        installed: installed(),
        importable: canImport,
        importFailed: Object.entries(state.importFailed).map(([tag, reason]) => ({ tag, reason })),
        jobs: jobs.list(),
        connect: { configured: false, active: false, model: '' },
        device: state.device,
        choices: state.choices,
        claude: describeClaude(),
        qwenCode: describeQwenCode(paths, env),
        kit: state.kit,
        diskUsedBytes: await dirSize(paths.root),
      };
    },

    describeConnect,

    quants,

    setChoice,

    addCustom,

    refreshHardware: () => readHardware(true),

    installRuntime(): LocalJob {
      return jobs.start('runtime', 'llama.cpp', provisionRuntime);
    },

    async startServer(body?: Partial<LocalModelBody>): Promise<LocalServerInfo> {
      const tag = body?.tag ?? readRecord(paths)?.tag ?? recommendedTag();
      if (!tag) throw localError('local-model-missing', 'нет скачанной модели', { tag: '—' });
      const request = { ...body, tag };
      const shape = await shapeFor(request);
      rememberChoice(request);
      supervisor.reset();
      // Человек запустил сам — отказ подъёма по запросу снят: следующий сбой снова получит попытки.
      resetOnDemand();
      await ensureServer(shape);
      return describeServer();
    },

    async stopServer(): Promise<{ unloaded: string[] }> {
      supervisor.forget();
      return managedBy(() => {
        // И в очереди тоже: подъём, шедший перед «Стопом», успел взять сервер под присмотр.
        supervisor.forget();
        return stopServer(paths, port, fetchImpl, deps.kill);
      });
    },

    /**
     * Скачать модель. С `inject` — по готовности ещё и включить её агентам:
     * так кнопка под чатом доводит дело до конца, даже если вкладку закрыли.
     */
    pull(body: LocalModelBody, inject?: Inject): LocalJob {
      const model = catalogModel(body.tag);
      if (!model)
        throw localError('local-model-unknown', `модели ${body.tag} нет в каталоге`, {
          tag: body.tag,
        });
      const quantId = body.quant ?? readState(paths).choices[body.tag]?.quant ?? model.defaultQuant;
      const quant = model.quants.find((item) => item.id === quantId);
      if (!quant)
        throw localError('local-quant-unknown', `у модели ${body.tag} нет квантования ${quantId}`, {
          tag: body.tag,
          quant: quantId,
        });
      return jobs.start('model', body.tag, async (handle) => {
        // Одна кнопка на чистой машине: сервера моделей нет — ставим свой в той
        // же работе, иначе «Скачать и подключить» падала бы на первом шаге.
        if (!runtimeBinary().binary) await provisionRuntime(handle);
        ensureDirs(paths);
        if (!filesOf(body.tag).some((file) => file.quant === quant.id))
          await downloadModelFile({ paths, repo: model.repo, file: quant.file, handle, fetchImpl });
        rememberChoice({ ...body, quant: quant.id });
        if (inject) {
          handle.progress({ phase: 'connect' });
          await connect(inject, { ...body, quant: quant.id });
        }
      });
    },

    importFromSystem(tag: string): LocalJob {
      return jobs.start('model', tag, (handle) => importOne(tag, handle));
    },

    /**
     * Удалить скачанное: одно квантование или всю модель (все квантования, недокачанные
     * хвосты, своя запись «Любой модели»). Сервер моделей НЕ останавливается никогда:
     * файл, который он держит или поднимет после идущего прогона, — отказ 409 с причиной,
     * остальные файлы удаляются при работающем сервере. Ничего за каталогом моделей.
     */
    async remove(tag: string, quant?: string): Promise<LocalRemoveResult> {
      if (jobs.find('model', tag))
        throw localError(
          'local-model-downloading',
          `модель ${tag} сейчас скачивается — дождитесь конца или отмените загрузку`,
          { tag },
        );
      const files = filesOf(tag).filter((file) => !quant || file.quant === quant);
      const model = catalogModel(tag);
      // Недокачанное лежит рядом с файлом (`.part`) и у квантований, которых в скачанном нет.
      const parts = (model?.quants ?? [])
        .filter((item) => !quant || item.id === quant)
        .map((item) => `${modelFilePath(paths, model?.repo ?? '', item.file)}.part`)
        .filter((path) => existsSync(path));
      const ownStore = !quant || quant === OLLAMA_QUANT;
      const manifest = ownStore ? manifestPathOf(paths.models, tag) : undefined;
      const targets = [
        ...files.map((file) => file.path),
        ...parts,
        ...(manifest ? [manifest] : []),
      ];
      if (targets.some((path) => !insideDir(paths.models, path)))
        throw localError(
          'local-model-path',
          `файл модели ${tag} лежит вне каталога моделей панели — удаление отклонено`,
          { tag },
        );
      // Запись стёрта неудачным подъёмом, а присмотр помнит сервер и поднимет его с этим файлом.
      const held = readRecord(paths) ?? supervisor.target();
      const loaded = files.find((file) => samePath(file.path, held?.file));
      if (loaded)
        throw localError(
          'local-model-loaded',
          `квантование ${loaded.quantLabel ?? loaded.quant} модели ${tag} загружено в сервер моделей — сначала остановите сервер`,
          { tag, quant: loaded.quantLabel ?? loaded.quant },
        );
      // Прогон идёт, а сервер после него перейдёт на выбранное (отложенный перезапуск, присмотр).
      const next = deps.runActive?.() && held?.tag === tag ? activeFile(tag) : undefined;
      const pending = files.find((file) => samePath(file.path, next?.path));
      if (pending)
        throw localError(
          'local-model-run-active',
          `идёт локальный прогон, после него сервер перейдёт на ${pending.quantLabel ?? pending.quant} модели ${tag} — удалите после прогона`,
          { tag, quant: pending.quantLabel ?? pending.quant },
        );

      let freedBytes = 0;
      for (const part of parts) freedBytes += removeCounted(part);
      for (const file of files) {
        freedBytes += removeCounted(file.path);
        pruneEmptyDirs(dirname(file.path), paths.models);
      }
      for (const part of parts) pruneEmptyDirs(dirname(part), paths.models);
      updateState(paths, (state) => {
        if (ownStore) delete state.imported[tag];
        if (!quant) {
          delete state.choices[tag];
          delete state.custom[tag];
          delete state.tools[tag];
        }
      });
      // Выбранное квантование удалено: выбор переходит на оставшееся на диске, нет таких — снимается.
      if (quant && readState(paths).choices[tag]?.quant === quant) {
        const fallback = activeFile(tag)?.quant;
        updateState(paths, (state) => {
          const choice = state.choices[tag];
          if (!choice) return;
          if (fallback) choice.quant = fallback;
          else delete choice.quant;
        });
      }
      // Прежняя загрузка Ollama в каталоге панели: без манифеста её не станут предлагать
      // снова, а слой, на который больше никто не ссылается, освобождает место.
      if (manifest) {
        await rm(manifest, { force: true });
        await dropUnreferencedBlobs(paths.models);
      }
      return { tag, removed: files.map((file) => file.quant), freedBytes };
    },

    async bench(tag: string): Promise<ModelBench> {
      // Всегда на выбранных квантовании и окне: замер на чужих ничего не доказывает.
      // Тот же запуск — сервер остаётся как есть, другой — перезапуск.
      const shape = await shapeFor({ tag });
      await ensureServer(shape);
      const hw = await readHardware();
      // Замер на процессоре — не замер карты: иначе каталог в режиме «процессор»
      // показывал бы скорость видеокарты рядом с оценкой 3–5.
      const where = device();
      const result = {
        ...benchOf(await client.bench(tag), where === 'cpu' ? 'cpu' : (hw.gpus[0]?.name ?? 'cpu')),
        device: where,
        context: shape.context,
        quant: shape.quant,
        kvCache: shape.kvCache,
        offload: shape.offload,
      };
      updateState(paths, (state) => {
        state.bench[tag] = result;
      });
      return result;
    },

    connect,

    disconnect: (inject: Inject) => disconnectLocal(inject),

    /**
     * Кнопка в шапке чата. Включение не ждёт загрузки модели: контур включается сразу,
     * сервер поднимается в фоне с настройками, выбранными модели (квантование, окно, кеш),
     * а запрос чата, пришедший раньше, ждёт того же подъёма (присмотр отвечает «занят»,
     * Claude Code повторяет). Неудача подъёма — причиной в подсказке, как у подъёма по запросу.
     * Выключение возвращает облако и освобождает видеопамять.
     */
    async toggle(inject: Inject, on: boolean, tag?: string): Promise<void> {
      if (!on) {
        await disconnectLocal(inject);
        supervisor.forget();
        await managedBy(() => {
          supervisor.forget();
          return stopServer(paths, port, fetchImpl, deps.kill);
        });
        return;
      }
      if (!runtimeBinary().binary)
        throw localError('local-runtime-missing', 'сервер моделей не установлен');
      // `tag` — человек выбрал модель прямо в окне кнопки: она становится моделью агентов.
      const known = await describeConnect(inject);
      const model = tag ?? (known.configured ? known.model : '');
      if (!model) throw localError('local-toggle-no-model', 'модель для агентов не выбрана');
      if (!activeFile(model))
        throw localError('local-model-missing', `модель ${model} не скачана`, { tag: model });
      const shape = await shapeFor({ tag: model });
      if (tag && (!known.configured || known.model !== tag)) {
        await saveLocalContour(inject, {
          baseUrl: baseUrlOf(port),
          model: tag,
          title: catalogModel(tag)?.title ?? tag,
        });
      }
      supervisor.reset();
      resetOnDemand();
      void ensureServer(shape).catch(noteStartFailure);
      await switchLocalOn(inject);
    },

    /**
     * Где считать. Идущий сервер перезапускается сразу: устройство задаётся
     * всему серверу, и выбор, вступающий в силу «когда-нибудь», человек не
     * отличит от несработавшего.
     */
    async setDevice(next: LocalDevice): Promise<LocalServerInfo> {
      updateState(paths, (state) => {
        state.device = next;
      });
      const record = readRecord(paths);
      if (record && (await probe(port, fetchImpl)) !== undefined) {
        if (!deferRestart()) {
          await ensureServer(await shapeFor({ tag: record.tag, quant: record.quant }));
        }
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
      if (!model || !activeFile(model))
        throw localError('local-model-missing', `модель ${model || '—'} не скачана`, {
          tag: model || '—',
        });
      const shape = await shapeFor({ tag: model });
      await ensureServer(shape);
      writeClaude(model, readRecord(paths)?.context ?? shape.context);
      return describeClaude();
    },

    /**
     * «Держать загруженной». Флаг простоя — аргумент запуска, поэтому идущий
     * сервер перезапускается сразу, как и при смене устройства: настройка, которая
     * вступит в силу «когда-нибудь», неотличима от несработавшей. Срок выгрузки — тот же
     * аргумент: сервер перезапускается, только если срок у него действительно другой.
     */
    async setKeepLoaded(keep: boolean, idleMinutes?: LocalIdleMinutes): Promise<LocalServerInfo> {
      updateState(paths, (state) => {
        state.keepLoaded = keep;
        if (idleMinutes) state.idleMinutes = idleMinutes;
      });
      const record = readRecord(paths);
      const changed = (record?.idleSeconds ?? 0) !== idleSecondsOf(readState(paths));
      if (record && changed && (await probe(port, fetchImpl)) !== undefined) {
        if (!deferRestart()) {
          await ensureServer(await shapeFor({ tag: record.tag, quant: record.quant }));
        }
      }
      return describeServer();
    },

    /**
     * «Не давать системе уснуть, пока идёт локальный прогон». Перезапуска не требует:
     * запрет ставит и снимает панель сама по числу идущих прогонов.
     */
    async setKeepAwake(on: boolean): Promise<LocalServerInfo> {
      updateState(paths, (state) => {
        state.keepAwake = on;
      });
      return describeServer();
    },

    /** Включён ли запрет сна системе (умолчание — да). */
    keepAwakeOn: (): boolean => readState(paths).keepAwake,

    /**
     * Перезапуск, который ждал конца прогона. Зовётся, когда локальных прогонов нет:
     * поднимает идущий сервер по сохранённому выбору. `false` — ждать нечего или прогон
     * ещё идёт. Сбой подъёма наружу не уходит: присмотр поднимет сервер по записи.
     */
    async applyPending(): Promise<boolean> {
      if (!pendingRestart || deps.runActive?.()) return false;
      const record = readRecord(paths);
      // После неудавшегося подъёма сервера может не быть вовсе — вторая попытка идёт всё равно.
      const tag = applyFailures > 0 ? (failedTag ?? record?.tag) : record?.tag;
      if (!tag || (applyFailures === 0 && (await probe(port, fetchImpl)) === undefined)) {
        setPending(false);
        return false;
      }
      try {
        await applyChoice(tag);
      } catch (error) {
        applyFailures += 1;
        failedTag = tag;
        // Первая неудача — ожидание остаётся, следующий опрос повторит. Вторая — человек
        // должен узнать: карточка называет причину, настройка лежит в выборе и подхватится
        // при следующем запуске сервера.
        if (applyFailures < 2) return false;
        restartError = error instanceof Error ? error.message : String(error);
        setPending(false);
        return false;
      }
      setPending(false);
      restartError = undefined;
      return true;
    },

    /** Ждёт ли настройка конца прогона. */
    restartPending: (): boolean => pendingRestart,

    /** MCP-серверы проекта для локального прогона: цена каждого, выбор, запас окна. */
    mcpInfo: (project: string) => mcp.describe(project),
    mcpMeasure: (project: string, ids?: string[]) => mcp.measure(project, ids),
    mcpPick: (project: string, servers: string[]) => mcp.pick(project, servers),
    /** Что идёт прогону проекта: записи выбранных серверов; ничего не выбрано — нет. */
    mcpRun: (project: string) => mcp.run(project),

    /** Claude уведён переключателем — для маршрутизации контура. */
    claudeRedirected: (): boolean => Boolean(readState(paths).claude),

    /**
     * Окружение переключателя для запусков без слоя `user` (лёгкое окно);
     * выключен — пусто, и такой запуск идёт как раньше.
     */
    claudeEnv: (): Record<string, string> =>
      deps.claude && readState(paths).claude ? readSwitchEnv(deps.claude.settingsPath()) : {},

    /**
     * Окружение прогона Claude на локальной модели: окно — настоящее окно
     * запущенного сервера. Сервера нет (ещё не поднят, остановлен) — наименьшее
     * окно агента: сжатие по меньшему окну наступит раньше, а не позже
     * переполнения. `route` — как запрос дойдёт до сервера: через шлюз панели или прямо
     * (переключатель Claude пишет адрес llama-server в settings.json).
     */
    runEnv: (route: 'gateway' | 'direct' = 'direct'): Record<string, string> => {
      const record = readRecord(paths);
      const speed = record ? readState(paths).bench[record.tag]?.promptTokensPerSec : undefined;
      return {
        ...localRunEnv(record?.context || AGENT_MIN_CONTEXT, speed),
        // Через шлюз — поиск инструментов (L7); переключатель Claude ведёт прямо на сервер.
        ...(route === 'gateway' ? LOCAL_GATEWAY_RUN_ENV : {}),
      };
    },

    /**
     * Окно и скорость обработки промпта для шлюза: нет записи о сервере — шлюзу
     * нечем отказывать, и он идёт как раньше. Скорость — замер этой модели.
     */
    upstream: (
      model: string,
    ):
      | {
          context: number;
          promptTokensPerSecond?: number;
          prepare: (session: string | undefined) => Promise<void>;
          revive: () => Promise<ReviveResult>;
          notice: () => string | undefined;
          watch: (promptTokens: number) => ActivityTrack;
          layer: (tokens: number) => void;
          readonly deferredInline: boolean;
        }
      | undefined => {
      const serverContext = (): number | undefined =>
        (readRecord(paths) ?? supervisor.target())?.context;
      const known = serverContext();
      // Сервера нет, а модель скачана — его поднимет первый же запрос (`startOnDemand`).
      const planned = known ?? (activeFile(model) ? plannedContext(model) : undefined);
      if (!planned) return undefined;
      const speed = readState(paths).bench[model]?.promptTokensPerSec;
      return {
        // Читается заново: после подъёма по запросу окно — настоящее окно поднятого сервера.
        get context(): number {
          return serverContext() ?? planned;
        },
        ...(speed ? { promptTokensPerSecond: speed } : {}),
        prepare: noteSession,
        revive: () => (known ? supervisor.revive() : startOnDemand(model)),
        notice: noticeText,
        watch: (promptTokens: number) => {
          slots.noteTokens(promptTokens);
          const track = activity.track(promptTokens);
          return {
            ...track,
            done: () => {
              track.done();
              slots.done();
            },
          };
        },
        layer: (tokens: number) => noteLayer(model, tokens),
        // Пометку знает только наш шаблон, и только тот, что сейчас лежит в данных: сервер,
        // поднятый с прежним (ждёт перезапуска), показал бы пометку модели вместо описания.
        get deferredInline(): boolean {
          const record = readRecord(paths);
          return Boolean(
            record?.templateFile &&
            record.templateHash !== undefined &&
            record.templateHash === templateHashOf(record.templateFile),
          );
        },
      };
    },

    /** На какую модель уведён Claude и как её подписать; выключено — нет. */
    claudeModel: (): { model: string; title: string } | undefined => {
      const claude = readState(paths).claude;
      return claude
        ? { model: claude.model, title: catalogModel(claude.model)?.title ?? claude.model }
        : undefined;
    },

    /**
     * После перезапуска панели: запись о сервере сверяется с живым процессом,
     * включённому Claude нужен живой сервер (иначе первый сеанс в терминале получит
     * отказ соединения), а модели прежнего хранилища забираются в llama.cpp.
     */
    async resume(): Promise<void> {
      supervisor.start();
      const claude = readState(paths).claude;
      if (claude && activeFile(claude.model))
        await ensureServer(await shapeFor({ tag: claude.model }));
      await migrateOwnStore();
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

    /** Что сервер делает с запросом чата прямо сейчас (L6). */
    async activity(): Promise<LocalActivity> {
      const layer = await layerFit();
      return { ...activity.snapshot(), ...(layer ? { layer } : {}) };
    },

    /** «Перезапустить» из чата: тот же сервер заново, теми же параметрами. */
    async restartServer(): Promise<LocalServerInfo> {
      if (!readRecord(paths) && !supervisor.target())
        throw localError('local-model-missing', 'нет скачанной модели', { tag: '—' });
      supervisor.reset();
      resetOnDemand();
      await restartServerNow();
      return describeServer();
    },

    shutdown(): void {
      clearInterval(slotSweeper);
      if (idleSaver) clearInterval(idleSaver);
      activity.stop();
      supervisor.stop();
      jobs.cancelAll();
    },

    logPath: join(paths.logs, 'llama.log'),
  };
}

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCAL_IDLE_MINUTES_DEFAULT,
  isLocalIdleMinutes,
  type KitMode,
  type LocalDevice,
  type LocalIdleMinutes,
  type ModelBench,
  type ModelChoiceInfo,
} from '@agentdeck/contracts/local-models';
import { writeTextFile } from '../../lib/safe-io/safe-io.ts';
import type { McpCostRecord } from './local-mcp.ts';

/**
 * Всё локальное — в ОДНОМ каталоге внутри панели: `<корень приложения>/.local-models`.
 *
 * Внутри панели, а не в `~/.cache` и не в профиле пользователя, по слову
 * владельца: человек должен видеть, где лежат гигабайты, и убирать их одной
 * кнопкой (или удалением папки), не вспоминая, какая программа куда что
 * положила. Каталог в `.gitignore`.
 */
export const LOCAL_MODELS_DIR = '.local-models';
/** Порт нашего сервера моделей. Не 11434: тот принадлежит Ollama пользователя, если он стоит; панель её не трогает. */
export const LOCAL_SERVER_PORT = 11435;

export interface LocalPaths {
  root: string;
  runtime: string;
  /** GGUF-файлы: `<репозиторий>/<файл>.gguf`; рядом `ollama-import/` и прежнее хранилище Ollama (`blobs/`, `manifests/`). */
  models: string;
  /** Жёсткие ссылки на слои моделей Ollama, которые открыл llama.cpp. */
  ollamaImport: string;
  downloads: string;
  tools: string;
  logs: string;
  run: string;
  state: string;
  pidFile: string;
  serverLog: string;
  /** Каталог слотов сервера (`--slot-save-path`): без него `POST /slots/0?action=erase` отвечает 501. */
  slotsDir: string;
}

export function localPaths(appRoot: string, env: NodeJS.ProcessEnv = process.env): LocalPaths {
  // Переопределение — для проверок: они гоняют весь путь на временном каталоге,
  // не трогая гигабайты владельца.
  const root = env.AGENTDECK_LOCAL_MODELS_DIR?.trim() || join(appRoot, LOCAL_MODELS_DIR);
  return {
    root,
    runtime: join(root, 'runtime'),
    models: join(root, 'models'),
    ollamaImport: join(root, 'models', 'ollama-import'),
    downloads: join(root, 'downloads'),
    tools: join(root, 'tools'),
    logs: join(root, 'logs'),
    run: join(root, 'run'),
    state: join(root, 'state.json'),
    pidFile: join(root, 'run', 'llama.json'),
    serverLog: join(root, 'logs', 'llama.log'),
    slotsDir: join(root, 'run', 'slots'),
  };
}

export function ensureDirs(paths: LocalPaths): void {
  for (const dir of [
    paths.root,
    paths.runtime,
    paths.models,
    paths.ollamaImport,
    paths.downloads,
    paths.tools,
    paths.logs,
    paths.run,
    paths.slotsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Что человек выбрал для модели; не названное подбирается под карту. */
export type ModelChoice = ModelChoiceInfo;

/** Модель из хранилища Ollama, которую открыл llama.cpp: файл — жёсткая ссылка на слой. */
export interface ImportedModel {
  /** Путь файла относительно `models/`. */
  file: string;
  sizeBytes: number;
  /** В файле есть слой предсказания нескольких токенов (`nextn_predict_layers` > 0). */
  mtp: boolean;
  importedAt: string;
}

/** Что раздел помнит между запусками панели. */
/** Замер слоя шлюзом (`LayerDetail` в `local-window.ts`). */
export interface LayerRecord {
  tokens: number;
  at: number;
  session?: string;
  frozenTools?: number;
}

/** Что шлюз сообщает о слое сверх токенов. */
export type LayerDetail = Pick<LayerRecord, 'session' | 'frozenTools'>;

export interface LocalState {
  bench: Record<string, ModelBench>;
  /** Выбор квантования, контекста и кеша по моделям. */
  choices: Record<string, ModelChoice>;
  imported: Record<string, ImportedModel>;
  /**
   * Модели, добавленные по имени репозитория («Любая модель»): запись в форме
   * каталога (её разбирает схема каталога при каждом чтении), ключ — тег.
   */
  custom: Record<string, Record<string, unknown>>;
  /** Итог пробы инструментов при подключении модели агентам: `ok` или `failed`. */
  tools: Record<string, 'ok' | 'failed'>;
  /** Модели Ollama, которых llama.cpp не открыл, и почему: их предлагается скачать заново. */
  importFailed: Record<string, string>;
  kit: { claude: KitMode; qwen: KitMode; variant: 'standard' | 'local' };
  /** Где считать: видеокарта (умолчание) или процессор. */
  device: LocalDevice;
  /** Claude Code уведён на локальную модель; нет записи — выключено. */
  claude?: ClaudeSwitchRecord;
  /** «Держать загруженной»: простой не выгружает модель из памяти (умолчание — выгружать). */
  keepLoaded: boolean;
  /** Через сколько минут простоя выгружать модель, когда её не держат. */
  idleMinutes: LocalIdleMinutes;
  /** Не давать ОС уснуть, пока идёт локальный прогон (умолчание — да). */
  keepAwake: boolean;
  /**
   * Настройка сохранена, а перезапуск сервера ждёт конца прогона. В файле, а не в памяти: после
   * перезапуска панели среди ночи идущий сервер иначе остался бы на старой настройке.
   */
  pendingRestart?: true;
  /** MCP-серверы, взятые в локальный прогон, по проектам (ключ — `projectKeyOf`); нет записи — ни одного. */
  mcpPicks: Record<string, string[]>;
  /** Замеренная цена инструментов сервера в токенах, по `scope:id`. */
  mcpCosts: Record<string, McpCostRecord>;
  /**
   * Слой прогона (системный промпт и инструменты), замеренный шлюзом, по моделям: токены и когда;
   * чей разговор и сколько в слое описаний MCP, замороженных этим разговором.
   */
  layers: Record<string, LayerRecord>;
}

/**
 * Что включение записало в settings.json и что там стояло до него. По `previous`
 * выключение возвращает файл как был (`null` — переменной не было), по
 * `written` узнаёт, что человек поменял руками после включения.
 */
export interface ClaudeSwitchRecord {
  model: string;
  settingsPath: string;
  written: Record<string, string>;
  previous: Record<string, string | null>;
  /**
   * Строка выбора модели (`modelPicker`): что записано и что стояло до включения
   * (`null` — ключа не было). Нет поля — запись старше подписи в выборе модели.
   */
  picker?: { written: ClaudeModelPicker; previous: unknown };
}

/** Ключ `modelPicker` пользовательского settings.json Claude Code (v2.1.242+). */
export interface ClaudeModelPicker {
  options: { model: string; label?: string; description?: string }[];
  replaceBuiltInOptions?: boolean;
}

export function defaultState(): LocalState {
  return {
    bench: {},
    choices: {},
    imported: {},
    custom: {},
    tools: {},
    importFailed: {},
    kit: { claude: 'global', qwen: 'global', variant: 'local' },
    device: 'gpu',
    keepLoaded: false,
    idleMinutes: LOCAL_IDLE_MINUTES_DEFAULT,
    keepAwake: true,
    mcpPicks: {},
    mcpCosts: {},
    layers: {},
  };
}

export function readState(paths: LocalPaths): LocalState {
  if (!existsSync(paths.state)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(paths.state, 'utf8')) as Partial<LocalState>;
    const base = defaultState();
    return {
      bench: raw.bench ?? base.bench,
      choices: raw.choices ?? base.choices,
      imported: raw.imported ?? base.imported,
      custom: raw.custom ?? base.custom,
      tools: raw.tools ?? base.tools,
      importFailed: raw.importFailed ?? base.importFailed,
      kit: { ...base.kit, ...(raw.kit ?? {}) },
      device: raw.device === 'cpu' ? 'cpu' : 'gpu',
      keepLoaded: raw.keepLoaded === true,
      idleMinutes: isLocalIdleMinutes(raw.idleMinutes) ? raw.idleMinutes : base.idleMinutes,
      keepAwake: raw.keepAwake !== false,
      ...(raw.pendingRestart === true ? { pendingRestart: true as const } : {}),
      mcpPicks: picksOf(raw.mcpPicks),
      mcpCosts: isRecord(raw.mcpCosts) ? raw.mcpCosts : base.mcpCosts,
      layers: layersOf(raw.layers),
      ...(raw.claude ? { claude: raw.claude } : {}),
    };
  } catch {
    // Испорченный файл состояния не должен запирать раздел: начинаем с умолчаний.
    return defaultState();
  }
}

/** Замер слоя читается на каждом опросе чата: запись не той формы пропускается, а не роняет раздел. */
function layersOf(value: unknown): LocalState['layers'] {
  if (!isRecord(value)) return {};
  const layers: LocalState['layers'] = {};
  for (const [tag, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const { tokens, at, session, frozenTools } = entry;
    if (typeof tokens === 'number' && tokens > 0 && typeof at === 'number') {
      layers[tag] = {
        tokens,
        at,
        ...(typeof session === 'string' ? { session } : {}),
        ...(typeof frozenTools === 'number' && frozenTools > 0 ? { frozenTools } : {}),
      };
    }
  }
  return layers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Выбор MCP читается на старте каждого локального прогона: запись не той формы
 * (правка руками, прежний формат) уронила бы сам прогон. Берутся только списки строк.
 */
function picksOf(value: unknown): LocalState['mcpPicks'] {
  if (!isRecord(value)) return {};
  const picks: LocalState['mcpPicks'] = {};
  for (const [project, ids] of Object.entries(value)) {
    if (Array.isArray(ids))
      picks[project] = ids.filter((id): id is string => typeof id === 'string');
  }
  return picks;
}

export function writeState(paths: LocalPaths, state: LocalState): void {
  mkdirSync(paths.root, { recursive: true });
  writeTextFile(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function updateState(paths: LocalPaths, change: (state: LocalState) => void): LocalState {
  const state = readState(paths);
  change(state);
  writeState(paths, state);
  return state;
}

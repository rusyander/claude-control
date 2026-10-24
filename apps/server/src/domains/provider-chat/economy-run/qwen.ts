import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import { readJsoncFile } from '../../../lib/safe-io/safe-io.ts';
import { ModelCatalogStore } from '../../models/model-store.ts';
import { baseSystemSettings } from '../../groups/qwen-layer/qwen-layer.ts';
import { writeQwenSettingsLayer } from '../../groups/qwen-run-layer/qwen-run-layer.ts';
import { layerDigest } from '../../groups/run-layer-parts.ts';
import type { EconomyRunInput } from './economy-run.types.ts';
import { qwenProviderEntry } from './qwen-model-providers.ts';
import type { QwenAuthType, QwenEconomyPatch, QwenProviderEntry } from './qwen.types.ts';

/**
 * Канал Qwen Code (облако и локальная модель): рычаги экономии группы — одним
 * слоем системных настроек на прогон (`QWEN_CODE_SYSTEM_SETTINGS_PATH`), поверх
 * уже выбранного файла: окно локальной модели → снятые серверы → тишина →
 * ЭТОТ слой → строка о каталоге. Каждый слой читает предыдущий файл и сливается
 * с ним, так что ни группы, ни настройки администратора не теряются. Системные
 * настройки Qwen главнее личных (`~/.qwen/settings.json`): рычаг группы
 * перекрывает свой ключ человека только на этом прогоне, сам файл цел.
 *
 * Ключи сверены с бандлом qwen-code 0.24.3 и живой пробой (22.10.2026):
 * - `context.autoCompactThreshold` — ДОЛЯ окна (0 < x ≤ 1), которую Qwen умножает
 *   на окно модели. Окно берётся в том же порядке, что у CLI: запись модели хода в
 *   `modelProviders` (её `generationConfig.contextWindowSize`; запись есть, а окна в
 *   ней нет — ключ верхнего уровня Qwen не читает, см. `qwen-model-providers.ts`),
 *   иначе `model.generationConfig.contextWindowSize` слитых настроек (системные →
 *   проекта → личные; у локальной модели его пишет слой окна), затем окно модели по каталогу
 *   контура, затем `contextLimit` каталога моделей панели по модели хода (у группы
 *   без назначенной модели — по своей модели CLI). Окна не знаем — ключа нет.
 *   Доля округляется ВНИЗ до 4 знаков и пишется, только если она меньше порога,
 *   который действовал бы и без рычага (свой ключ человека, иначе 0,85 самого CLI):
 *   рычаг экономии не вправе сжимать историю ПОЗЖЕ, чем без него;
 * - `tools.truncateToolOutputThreshold` — предел ответа инструмента в ЗНАКАХ, один на
 *   все инструменты: проба показала, что им режется и оболочка, и `read_file`.
 *   Поэтому значение — рычаг вывода оболочки (решение O2), рычаг чтения у Qwen
 *   своего ключа не имеет;
 * - `ide.enabled: false` — `serve` поднимает дочерние `--acp`, а те при включённом
 *   редакторе подключаются к нему на старте (`connectIdeForStartup`): панель,
 *   запущенная из терминала редактора, иначе тянула бы его контекст в группу;
 * - `model.generationConfig.cacheRetention: '1h'` — только при входе через
 *   Anthropic: остальные генераторы ключ не читают, и слой незачем менять.
 *   '5m' — умолчание самого CLI (`ephemeral`), ключ не пишется.
 *
 * Рычаги закреплены на первом старте разговора, окно читается на ходу, а
 * каталог слоя — по содержимому: у одного разговора ходы получают один и тот же
 * файл, и начало запроса (кэш) между ходами не меняется.
 */

export function qwenEconomyLayersRoot(appData: string): string {
  return join(appData, 'qwen-economy-layers');
}

function objectAt(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Файл настроек Qwen — с комментариями, как его читает сам CLI; нет файла или он
 * не разбирается — пусто (экономия не главнее хода).
 */
function settingsFile(path: string): Record<string, unknown> {
  try {
    return objectAt(readJsoncFile<unknown>(path, {}));
  } catch {
    return {};
  }
}

/**
 * Настройки Qwen в порядке старшинства самого CLI (`mergeSettings` бандла): системные
 * (слой прогона — файл, выбранный до канала), проекта (`<каталог>/.qwen/settings.json`),
 * личные. Настройки проекта CLI читает, только если папке доверяет; проверка доверия
 * по умолчанию выключена — тогда доверяет всем. Включена — список доверенных папок
 * канал не разбирает и проект не считает: лучше не тронуть рычаг, чем решить по
 * файлу, которого CLI не увидит.
 */
export function qwenSettingsLayers(
  env: NodeJS.ProcessEnv,
  system: Record<string, unknown>,
  workdir: string | undefined,
): Record<string, unknown>[] {
  const own = qwenOwnSettings(env);
  const trustOn = settingAt([system, own], ['security', 'folderTrust', 'enabled']) === true;
  const workspace =
    workdir && !trustOn ? settingsFile(join(workdir, '.qwen', 'settings.json')) : {};
  return [system, workspace, own];
}

/** Значение по пути — из первого слоя, где оно задано (слои — от старшего к младшему). */
export function settingAt(layers: readonly Record<string, unknown>[], path: string[]): unknown {
  for (const layer of layers) {
    let value: unknown = layer;
    for (const key of path) value = objectAt(value)[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Как Qwen войдёт в модель — тем же порядком, что сам CLI: выбранный тип в
 * настройках (системные → проекта → личные), затем по переменным окружения
 * (`getAuthTypeFromEnv` бандла). `modelProviders` вид входа на Anthropic не
 * переводят: выбор модели в 0.24.3 меняет только `openai` ↔ `openai-responses`
 * (`resolveModelSelectionAuthType`).
 */
export function qwenAuthType(
  env: NodeJS.ProcessEnv,
  layers: readonly Record<string, unknown>[],
): QwenAuthType | undefined {
  const chosen = settingAt(layers, ['security', 'auth', 'selectedType']);
  if (typeof chosen === 'string' && chosen) return chosen;
  if (env.QWEN_OAUTH) return 'qwen-oauth';
  if (env.OPENAI_API_KEY && (env.OPENAI_MODEL || env.QWEN_MODEL) && env.OPENAI_BASE_URL) {
    return 'openai';
  }
  if (env.GEMINI_API_KEY && env.GEMINI_MODEL) return 'gemini';
  if ((env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_PROJECT) && env.GOOGLE_MODEL) return 'vertex-ai';
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL && env.ANTHROPIC_BASE_URL) return 'anthropic';
  return undefined;
}

/** Личные настройки Qwen (`<QWEN_HOME>/settings.json`); нет файла — пусто. */
export function qwenOwnSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const home = env.QWEN_HOME || join(homedir(), '.qwen');
  return settingsFile(join(home, 'settings.json'));
}

/** Переменные модели по виду входа — `AUTH_ENV_MODEL_VARS` бандла. */
const AUTH_MODEL_ENV: Record<string, readonly string[]> = {
  openai: ['OPENAI_MODEL', 'QWEN_MODEL'],
  'openai-responses': ['OPENAI_MODEL'],
  gemini: ['GEMINI_MODEL'],
  'vertex-ai': ['GOOGLE_MODEL'],
  anthropic: ['ANTHROPIC_MODEL'],
};

/** Приставка снимка модели, которую Qwen снимает с `model.name` (`$runtime|вход|id`). */
const RUNTIME_SNAPSHOT_PREFIX = '$runtime|';

/** `model.name` слитых настроек без приставки снимка — как читает его CLI. */
export function settingModelName(layers: readonly Record<string, unknown>[]): string | undefined {
  const named = settingAt(layers, ['model', 'name']);
  if (typeof named !== 'string' || !named) return undefined;
  let id = named;
  while (id.startsWith(RUNTIME_SNAPSHOT_PREFIX)) {
    const stripped = id.split('|').slice(2).join('|');
    if (!stripped) break;
    id = stripped;
  }
  return id;
}

/**
 * Модель, на которой Qwen пойдёт без флага `--model`: группа чужого CLI без
 * лестницы модели не получает, и CLI берёт свою. Порядок — как в самом CLI
 * (`resolveCliGenerationConfig`): `model.name` слитых настроек (системные →
 * проекта → личные), затем переменная модели выбранного вида входа.
 */
export function qwenRunModel(
  env: NodeJS.ProcessEnv,
  layers: readonly Record<string, unknown>[],
  auth: QwenAuthType | undefined,
): string | undefined {
  const named = settingModelName(layers);
  if (named) return named;
  for (const key of auth ? (AUTH_MODEL_ENV[auth] ?? []) : []) {
    if (env[key]) return env[key];
  }
  return undefined;
}

/**
 * Окно облачной модели по каталогу панели (models.dev) — по ВСЕМ вендорам: под Qwen
 * ходят и чужие модели (OpenAI-совместимые, Claude при входе через Anthropic), а
 * список моделей Qwen в выборе — только alibaba. Нет модели или записи — неизвестно.
 */
export function cloudContextLimit(appData: string, model: string | undefined): number | undefined {
  if (!model) return undefined;
  const models = new ModelCatalogStore(appData).allModels();
  const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  // Точное имя (с префиксом вендора) главнее голого: у разных вендоров один id бывает.
  const exact = models.find((entry) => `${entry.vendor}/${entry.id}` === model);
  const entry = exact ?? models.find((one) => one.id === model || one.id === id);
  return positive(entry?.contextLimit);
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Окно, на которое Qwen умножит долю, — порядок в шапке файла. Локальная модель
 * приходит первым же шагом: её окно в настройки пишет слой окна прогона.
 */
export function qwenContextWindow(options: {
  layers: readonly Record<string, unknown>[];
  /** Запись модели хода в `modelProviders` (`qwenProviderEntry`); есть — верхний ключ не в счёт. */
  providerEntry?: QwenProviderEntry;
  localContextWindow?: number;
  modelContext?: number;
  catalog: () => number | undefined;
}): number | undefined {
  const entry = options.providerEntry;
  // Окно задано в записи, но не числом > 0 — Qwen возьмёт его как есть, а долю от
  // такого числа канал не считает: ключа нет.
  if (entry?.hasWindow) return positive(entry.window);
  const own = entry
    ? undefined
    : positive(settingAt(options.layers, ['model', 'generationConfig', 'contextWindowSize']));
  return (
    own ??
    positive(options.localContextWindow) ??
    positive(options.modelContext) ??
    options.catalog()
  );
}

/** Умолчание доли самого CLI (`DEFAULT_PCT` бандла). */
const QWEN_DEFAULT_COMPACT_PCT = 0.85;

/** Порог, который действовал бы без рычага: ключ слитых настроек, иначе 0,85. */
export function qwenEffectiveThreshold(layers: readonly Record<string, unknown>[]): number {
  const own = settingAt(layers, ['context', 'autoCompactThreshold']);
  // Тот же фильтр, что у CLI (`getAutoCompactThreshold`): вне (0, 1] — умолчание.
  return typeof own === 'number' && own > 0 && own <= 1 ? own : QWEN_DEFAULT_COMPACT_PCT;
}

/**
 * Что рычаги меняют в настройках — без файлов, чтобы решение проверялось само по
 * себе. Пусто — `undefined`: слой не нужен.
 */
export function qwenEconomyPatch(options: {
  economy?: GroupEconomy;
  compactWindow?: number;
  window?: number;
  /** Порог, который действовал бы без рычага (`qwenEffectiveThreshold`); нет — 0,85. */
  threshold?: number;
  auth?: QwenAuthType;
}): QwenEconomyPatch | undefined {
  const { economy, compactWindow, window } = options;
  const patch: QwenEconomyPatch = {};
  // Доля — вниз до 4 знаков (округление вверх дало бы 1 при 131070 из 131072) и
  // строго меньше порога без рычага: иначе рычаг экономии сжимал бы ПОЗЖЕ CLI
  // (950k из 1M — 0,95 против его 0,85) или поверх более дешёвого ключа человека.
  const fraction =
    compactWindow && window && compactWindow > 0
      ? Math.floor((compactWindow * 10_000) / window) / 10_000
      : 0;
  if (fraction > 0 && fraction < (options.threshold ?? QWEN_DEFAULT_COMPACT_PCT)) {
    patch.autoCompactThreshold = fraction;
  }
  if (economy?.bashOutputChars) patch.truncateToolOutputThreshold = economy.bashOutputChars;
  if (economy?.detachIde) patch.ideEnabled = false;
  if (economy?.cacheTtl === '1h' && options.auth === 'anthropic') patch.cacheRetention = '1h';
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Патч поверх выбранного файла: прочие ключи тех же разделов остаются. */
export function mergeQwenEconomy(
  base: Record<string, unknown>,
  patch: QwenEconomyPatch,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  if (patch.autoCompactThreshold !== undefined) {
    merged.context = {
      ...objectAt(base.context),
      autoCompactThreshold: patch.autoCompactThreshold,
    };
  }
  if (patch.truncateToolOutputThreshold !== undefined) {
    merged.tools = {
      ...objectAt(base.tools),
      truncateToolOutputThreshold: patch.truncateToolOutputThreshold,
    };
  }
  if (patch.ideEnabled !== undefined) {
    merged.ide = { ...objectAt(base.ide), enabled: patch.ideEnabled };
  }
  if (patch.cacheRetention !== undefined) {
    const model = objectAt(base.model);
    merged.model = {
      ...model,
      generationConfig: {
        ...objectAt(model.generationConfig),
        cacheRetention: patch.cacheRetention,
      },
    };
  }
  return merged;
}

export function qwenEconomyEnv(
  input: EconomyRunInput & { now?: number },
): Record<string, string> | undefined {
  const base = baseSystemSettings(input.env);
  const needsWindow = Boolean(input.compactWindow);
  const needsAuth = input.economy?.cacheTtl === '1h' || needsWindow;
  // Личные и проектные настройки читаются, только когда решают что-то из рычагов.
  const layers = needsAuth ? qwenSettingsLayers(input.env, base, input.workdir) : [base];
  const auth = needsAuth ? qwenAuthType(input.env, layers) : undefined;
  // Окно: настройки CLI (запись модели в `modelProviders`, иначе ключ верхнего
  // уровня) → каталог контура → каталог моделей по модели хода, а без неё — по
  // своей модели CLI.
  const runModel = input.model || qwenRunModel(input.env, layers, auth);
  // Сохранённый адрес выбирает запись, только когда модель взята из `model.name`.
  const fromSettings = !input.model && Boolean(runModel) && runModel === settingModelName(layers);
  const persistedBaseUrl = fromSettings ? settingAt(layers, ['model', 'baseUrl']) : undefined;
  const providerEntry = needsWindow
    ? qwenProviderEntry({
        modelProviders: settingAt(layers, ['modelProviders']),
        providerProtocol: settingAt(layers, ['providerProtocol']),
        auth,
        model: runModel,
        ...(typeof persistedBaseUrl === 'string' && persistedBaseUrl ? { persistedBaseUrl } : {}),
      })
    : undefined;
  const window = needsWindow
    ? qwenContextWindow({
        layers,
        ...(providerEntry ? { providerEntry } : {}),
        ...(input.localContextWindow ? { localContextWindow: input.localContextWindow } : {}),
        ...(input.modelContext ? { modelContext: input.modelContext } : {}),
        catalog: () => cloudContextLimit(input.appData, runModel),
      })
    : undefined;
  const patch = qwenEconomyPatch({
    ...(input.economy ? { economy: input.economy } : {}),
    ...(input.compactWindow ? { compactWindow: input.compactWindow } : {}),
    ...(window ? { window, threshold: qwenEffectiveThreshold(layers) } : {}),
    ...(auth ? { auth } : {}),
  });
  if (!patch) return undefined;
  const merged = mergeQwenEconomy(base, patch);
  return writeQwenSettingsLayer(
    qwenEconomyLayersRoot(input.appData),
    layerDigest({ kind: 'qwen-economy', merged }),
    merged,
    input.now,
  );
}

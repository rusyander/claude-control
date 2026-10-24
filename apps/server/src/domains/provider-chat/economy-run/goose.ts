import { join } from 'node:path';
import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import { gooseConfigDir } from '../../../providers/catalog/config-dirs.ts';
import { readConfigRoot } from '../../../providers/catalog/run-endpoint.ts';
import { ModelCatalogStore } from '../../models/model-store.ts';
import type { EconomyRunInput } from './economy-run.types.ts';

/** Доля окна, на которой Goose сжимает историю (по умолчанию у него 0.8). */
export const GOOSE_COMPACT_THRESHOLD_ENV = 'GOOSE_AUTO_COMPACT_THRESHOLD';
/** Окно модели, токены: Goose считает долю сжатия от него. */
export const GOOSE_CONTEXT_LIMIT_ENV = 'GOOSE_CONTEXT_LIMIT';
/** Потолок ответа инструмента, ЗНАКИ: больше — ответ уходит в файл, модель видит ссылку. */
export const GOOSE_TOOL_RESPONSE_ENV = 'GOOSE_MAX_TOOL_RESPONSE_SIZE';

/** Провайдер и модель Goose: окружение главнее `config.yaml`, как у самого Goose. */
const GOOSE_PROVIDER_ENV = 'GOOSE_PROVIDER';
const GOOSE_MODEL_ENV = 'GOOSE_MODEL';

/** Знаков на токен — та же мера, что у Codex (решение O2). */
const CHARS_PER_TOKEN = 4;

/**
 * Провайдер Goose → вендор каталога моделей панели (models.dev). Остальные
 * провайдеры (openrouter, databricks, …) отдают модель под чужим именем — вендор
 * тогда берётся из приставки `вендор/модель`, а без неё окно неизвестно: один и
 * тот же id у разных вендоров каталога бывает с разным окном.
 */
const PROVIDER_VENDOR: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  gemini_cli: 'google',
};

/** Откуда канал читает `config.yaml` и окружение сервера — подменяется в тестах. */
export interface GooseEconomyDeps {
  readConfig?: () => Record<string, unknown>;
  /**
   * Окружение, которое Goose унаследует от сервера: `input.env` — только то, что
   * прогон кладёт поверх, а `GOOSE_MODEL` человека живёт в окружении сервера.
   */
  processEnv?: NodeJS.ProcessEnv;
}

const readGooseConfig = (): Record<string, unknown> =>
  readConfigRoot(join(gooseConfigDir(), 'config.yaml'), 'yaml');

/**
 * Канал Goose: рычаги — переменными окружения запуска. Goose читает их ПОВЕРХ
 * своего `config.yaml` на каждом обращении к ключу, поэтому конфиг человека цел.
 * Живая проба 22.10.2026 (goose 1.54.0, заглушка OpenAI, временный дом):
 * переменные доходят и до одиночного `goose run`, и до `goose acp`, который
 * панель поднимает на каждый ответ (`live/goose-acp.ts`).
 *
 * - Порог сжатия — доля окна (`GOOSE_AUTO_COMPACT_THRESHOLD`), а не токены:
 *   окно группы делится на окно модели. На пробе окно 2000 и доля 0.3 дали
 *   запрос «Please summarize the conversation history» в начале второго хода.
 *   Окно: `GOOSE_CONTEXT_LIMIT` человека (окружение или `config.yaml`) — его
 *   выбор, он главнее; иначе окно локальной модели, иначе окно модели по каталогу
 *   контура (`route.modelContext`), иначе окно облачной модели
 *   хода по каталогу моделей панели (`contextLimit`, как у Qwen Code). Модель
 *   хода у Goose — ТОЛЬКО `GOOSE_MODEL` (окружение прогона — так панель ведёт
 *   Goose в контур, — затем окружение сервера, затем `config.yaml`): флага модели
 *   панель ему не передаёт, и модель из шапки разговора до него не доходит —
 *   по ней окно было бы чужим. Найденное панелью окно уходит Goose вместе с долей, чтобы
 *   доля считалась от того же числа, а не от его догадки об окне. Окна нет —
 *   рычаг молчит (доля от неизвестного числа сжимала бы наугад), и отметка
 *   рычага в каталоге говорит это условие словами.
 * - Потолок ответа инструмента (`GOOSE_MAX_TOOL_RESPONSE_SIZE`) — ЗНАКИ, на все
 *   инструменты сразу. Проба: вывод оболочки 6000 знаков при потолке 3000 ушёл
 *   в файл, и модель получила строку в 217 знаков со ссылкой на него; при 7000 —
 *   весь вывод. Ключ один, рычагов два — берётся больший (как O2 у Codex):
 *   max(вывод оболочки, чтение × 4), чтобы предел оболочки не урезал чтение.
 * - Срок кэша (`GOOSE_CACHE_TTL`) не пишется: проба на провайдере Anthropic
 *   показала, что запрос с ним тот же (`cache_control` без срока) — см. каталог.
 */
export function gooseEconomyEnv(
  input: EconomyRunInput,
  deps: GooseEconomyDeps = {},
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  Object.assign(
    env,
    gooseCompactEnv(input, deps.readConfig ?? readGooseConfig, deps.processEnv ?? process.env),
  );
  const tool = gooseToolResponseLimit(input.economy);
  if (tool) env[GOOSE_TOOL_RESPONSE_ENV] = String(tool);
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Целое > 0 из числа или строки ключа; иначе — нет. */
function positiveInt(raw: unknown): number | undefined {
  const value = typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Непустая строка ключа; иначе — нет. */
function text(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Окно облачной модели по каталогу моделей панели (models.dev): вендор — по
 * провайдеру Goose, у прочих провайдеров — по приставке `вендор/модель`. Id
 * сверяется как есть, без приставки и с точкой версии, записанной дефисом
 * (`claude-sonnet-4.5` у openrouter — `claude-sonnet-4-5` в каталоге). Нет
 * модели, вендора, записи или её окна — неизвестно.
 */
export function gooseCatalogWindow(
  appData: string,
  provider: string | undefined,
  model: string | undefined,
): number | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  const prefix = slash > 0 ? model.slice(0, slash) : undefined;
  const vendor = (provider ? PROVIDER_VENDOR[provider] : undefined) ?? prefix;
  if (!vendor) return undefined;
  const bare = model.slice(model.lastIndexOf('/') + 1);
  const ids = new Set([model, bare, bare.replace(/(\d)\.(\d)/g, '$1-$2')]);
  const models = new ModelCatalogStore(appData).current([vendor]).models;
  return positiveInt(models.find((entry) => ids.has(entry.id))?.contextLimit);
}

/**
 * Доля сжатия от окна модели. Окно, заданное человеком (окружение сильнее
 * `config.yaml`, как у самого Goose), не трогается и не повторяется; окно,
 * найденное панелью (локальная модель, каталог), передаётся явно — без него
 * Goose считал бы долю от своего предположения об окне.
 */
function gooseCompactEnv(
  input: EconomyRunInput,
  readConfig: () => Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  const window = input.compactWindow;
  if (!window || window <= 0) return undefined;
  const config = readConfig();
  // Порядок самого Goose: окружение процесса (прогон поверх сервера) главнее config.yaml.
  const key = (name: string): unknown =>
    text(input.env[name]) ?? text(processEnv[name]) ?? config[name];
  const known = positiveInt(key(GOOSE_CONTEXT_LIMIT_ENV));
  // Окно контура — его модели, а её Goose и получает (`GOOSE_MODEL` прогона): то же
  // место в порядке, что у Qwen Code, — после выбора человека, до каталога.
  const limit =
    known ??
    positiveInt(input.localContextWindow) ??
    positiveInt(input.modelContext) ??
    gooseCatalogWindow(input.appData, text(key(GOOSE_PROVIDER_ENV)), text(key(GOOSE_MODEL_ENV)));
  if (!limit || window >= limit) return undefined;
  // Четыре знака хватает: 0.0001 окна в миллион токенов — сто токенов.
  const fraction = Math.round((window / limit) * 10_000) / 10_000;
  if (!(fraction > 0 && fraction < 1)) return undefined;
  return {
    [GOOSE_COMPACT_THRESHOLD_ENV]: String(fraction),
    ...(known ? {} : { [GOOSE_CONTEXT_LIMIT_ENV]: String(limit) }),
  };
}

/**
 * Потолок ответа инструмента в знаках. Ноль у любого из двух рычагов — «этот
 * инструмент не трогать»: одним ключом нельзя урезать один инструмент, оставив
 * другой на умолчании Goose, поэтому ключа нет вовсе (как у Codex).
 */
export function gooseToolResponseLimit(economy: GroupEconomy | undefined): number | undefined {
  if (!economy) return undefined;
  const bash = economy.bashOutputChars;
  const read = economy.readOutputTokens;
  if (!(bash > 0) || !(read > 0)) return undefined;
  const limit = Math.max(Math.ceil(bash), Math.ceil(read * CHARS_PER_TOKEN));
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseCodexToml } from '../../../lib/codex-toml/codex-toml.ts';
import { readDotenvVars } from '../../../lib/dotenv-file/dotenv-file.ts';
import { codexHome } from '../../../providers/catalog/config-dirs.ts';
import { activeCodexEntries, entryRoutesToGateway } from '../../platform/apply/current.ts';
import { baseSystemSettings } from '../../groups/qwen-layer/qwen-layer.ts';
import {
  qwenAuthType,
  qwenRunModel,
  qwenSettingsLayers,
  settingAt,
  settingModelName,
} from '../economy-run/qwen.ts';
import { qwenProviderEntry } from '../economy-run/qwen-model-providers.ts';

/**
 * Идёт ли следующий прогон чужого CLI на локальный сервер моделей человека по
 * СОБСТВЕННЫМ настройкам CLI (Qwen Code, Codex), а не через контур панели. Такой
 * прогон кэша провайдера не платит: R2 «холодный кэш» и новый разговор после срока
 * кэша (`freshOnColdResume`) ему не нужны — продолжать на локальной модели бесплатно,
 * а новый разговор теряет контекст.
 *
 * Локальный — петлевой адрес (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) или
 * встроенный локальный провайдер Codex (`oss`, `ollama`, `lmstudio`). Шлюз панели тоже
 * петлевой, но за ним облако — он не в счёт (`entryRoutesToGateway`). Прогон, который
 * повёл контур, решает маршрут, а не этот ответ. Адреса нет, файл не читается, вид
 * входа облачный — НЕ локальный: ложное «локальный» спрятало бы настоящий расход.
 */
export interface OwnEndpointInput {
  providerId: string;
  /** Окружение прогона целиком: окружение панели и слои прогона поверх. */
  env: NodeJS.ProcessEnv;
  /** Каталог разговора: настройки и `.env` проекта Qwen Code. */
  workdir?: string;
  /** Модель хода (`--model`); пусто — CLI берёт свою из настроек. */
  model?: string;
  /** Контуры панели и порт шлюза — чтобы отличить шлюз от своего сервера. */
  platformIds: readonly string[];
  gatewayPort: number;
  /** Домашний каталог (`~/.env`); для проверок. */
  home?: string;
}

/** Встроенные провайдеры Codex на локальном сервере (`model_provider`); переопределить их нельзя. */
const CODEX_LOCAL_PROVIDERS = new Set(['oss', 'ollama', 'lmstudio']);

/** Переменная адреса по виду входа Qwen (`AUTH_ENV_MAPPINGS` бандла 0.24.3); нет — адрес облачный. */
const QWEN_BASE_URL_ENV: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  'openai-responses': 'OPENAI_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
};

export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function localUrl(baseUrl: string | undefined, input: OwnEndpointInput, name = ''): boolean {
  if (!baseUrl || !isLoopbackUrl(baseUrl)) return false;
  return !entryRoutesToGateway({ name, baseUrl }, input.platformIds, input.gatewayPort);
}

/**
 * Codex: выбранный провайдер (`profile` → его `model_provider`, иначе корневой,
 * иначе облачный `openai`) и его `base_url`. Любая из выбранных записей уводит в
 * шлюз — не локальный.
 */
function codexLocal(input: OwnEndpointInput): boolean {
  const file = join(input.env.CODEX_HOME || codexHome(), 'config.toml');
  if (!existsSync(file)) return false;
  const parsed = parseCodexToml(readFileSync(file, 'utf8'));
  const entries = activeCodexEntries(parsed);
  if (entries.some((entry) => entryRoutesToGateway(entry, input.platformIds, input.gatewayPort))) {
    return false;
  }
  const profileName = parsed.profile;
  const profiles = parsed.profiles as Record<string, { model_provider?: unknown }> | undefined;
  const fromProfile =
    typeof profileName === 'string' ? profiles?.[profileName]?.model_provider : undefined;
  const name =
    typeof fromProfile === 'string'
      ? fromProfile
      : typeof parsed.model_provider === 'string'
        ? parsed.model_provider
        : 'openai';
  const baseUrl = entries.find((entry) => entry.name === name)?.baseUrl;
  if (CODEX_LOCAL_PROVIDERS.has(name)) {
    // Встроенный локальный: адрес — `CODEX_OSS_BASE_URL`, иначе localhost.
    const oss = baseUrl ?? input.env.CODEX_OSS_BASE_URL;
    return oss ? localUrl(oss, input, name) : true;
  }
  return localUrl(baseUrl, input, name);
}

/**
 * Файлы `.env`, которые Qwen подмешает в окружение (`findEnvFiles` бандла): первый
 * `.qwen/.env` или `.env` вверх от каталога разговора до домашнего, затем
 * `<QWEN_HOME>/.env`, `~/.qwen/.env`, `~/.env`. Доверие к папке не сверяется — по
 * умолчанию оно выключено, и CLI читает все.
 */
function qwenEnvFiles(input: OwnEndpointInput, home: string): string[] {
  const files: string[] = [];
  if (input.workdir) {
    for (let dir = resolve(input.workdir); dir !== home; dir = dirname(dir)) {
      const found = [join(dir, '.qwen', '.env'), join(dir, '.env')].find((path) =>
        existsSync(path),
      );
      if (found) {
        files.push(found);
        break;
      }
      if (dirname(dir) === dir) break;
    }
  }
  const qwenDir = input.env.QWEN_HOME ? resolve(input.env.QWEN_HOME) : join(home, '.qwen');
  files.push(join(qwenDir, '.env'), join(home, '.qwen', '.env'), join(home, '.env'));
  return files.filter((path) => existsSync(path));
}

/**
 * Окружение, которое увидит Qwen: окружение прогона, затем незаданное — из `.env`
 * (первый файл главнее), затем из `env` слитых настроек. Неразборчивый `.env` —
 * ошибка: адрес неизвестен.
 */
function qwenEffectiveEnv(
  input: OwnEndpointInput,
  layers: readonly Record<string, unknown>[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.env };
  const fill = (key: string, value: unknown) => {
    if (!env[key] && typeof value === 'string') env[key] = value;
  };
  for (const file of qwenEnvFiles(input, input.home ?? homedir())) {
    for (const { key, value } of readDotenvVars(readFileSync(file, 'utf8'))) fill(key, value);
  }
  const fromSettings = settingAt(layers, ['env']);
  if (fromSettings && typeof fromSettings === 'object') {
    for (const [key, value] of Object.entries(fromSettings)) fill(key, value);
  }
  return env;
}

/**
 * Qwen Code: адрес тем же порядком, что у CLI (`resolveModelConfig` бандла 0.24.3):
 * запись модели хода в `modelProviders` → переменная адреса вида входа →
 * `security.auth.baseUrl`. `model.baseUrl` сам адресом не служит — он только выбирает
 * запись (`qwen-model-providers.ts`).
 */
function qwenLocal(input: OwnEndpointInput): boolean {
  const layers = qwenSettingsLayers(input.env, baseSystemSettings(input.env), input.workdir);
  const env = qwenEffectiveEnv(input, layers);
  const auth = qwenAuthType(env, layers);
  const envKey = auth ? QWEN_BASE_URL_ENV[auth] : undefined;
  if (!envKey) return false;
  const runModel = input.model || qwenRunModel(env, layers, auth);
  const fromSettings = !input.model && Boolean(runModel) && runModel === settingModelName(layers);
  const persistedBaseUrl = fromSettings ? settingAt(layers, ['model', 'baseUrl']) : undefined;
  const entry = qwenProviderEntry({
    modelProviders: settingAt(layers, ['modelProviders']),
    providerProtocol: settingAt(layers, ['providerProtocol']),
    auth,
    model: runModel,
    ...(typeof persistedBaseUrl === 'string' && persistedBaseUrl ? { persistedBaseUrl } : {}),
  });
  const fromAuth = settingAt(layers, ['security', 'auth', 'baseUrl']);
  const baseUrl =
    entry?.baseUrl || env[envKey] || (typeof fromAuth === 'string' ? fromAuth : undefined);
  return localUrl(baseUrl, input);
}

export function ownLocalEndpoint(input: OwnEndpointInput): boolean {
  try {
    if (input.providerId === 'codex') return codexLocal(input);
    if (input.providerId === 'qwen') return qwenLocal(input);
    return false;
  } catch {
    // Не разобрали настройки — облако, как до этого ответа.
    return false;
  }
}

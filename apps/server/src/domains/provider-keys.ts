import type {
  AppSettings,
  KeySource,
  KeyStatus,
  ProviderKeyItem,
  RunnerMode,
  RunnerReason,
} from '@claude-control/contracts';
import {
  getActiveProvider,
  getProvider,
  isKnownProviderId,
  listProviders,
} from '../providers/registry.ts';
import { providerCliCandidates, providerCliCommand } from '../providers/cli.ts';
import type { AssistantApiKind, ConfigProvider } from '../providers/types.ts';
import {
  getStoredKey,
  maskKey,
  setStoredKey,
  clearStoredKey,
  MAX_KEY_LENGTH,
} from '../lib/provider-keys.ts';
import { detectCliOnPath, findCliOnPath } from '../providers/detect.ts';

/**
 * Резолвинг ключей и раннера ассистента (Ф6a). Инфраструктура мультимодельного
 * ассистента: понять, откуда взять ключ активного провайдера и как его запускать
 * (`api` / `cli` / `none`). Реальных вызовов моделей здесь НЕТ — только резолвинг.
 *
 * БЕЗОПАСНОСТЬ: ключи наружу отдаются только маскированными; сам ключ не покидает
 * сервер (см. `lib/provider-keys.ts`). Автоподхват из окружения — ТОЛЬКО по
 * стандартным именам переменных, заявленным провайдером (`apiKeyEnvVars`); чужие
 * форматы не угадываем.
 */

interface KeysSettingsSource {
  getSettings(): Pick<AppSettings, 'provider'>;
}

/**
 * Формы ключа и раннера описаны в контракте (`packages/contracts/src/provider-keys.ts`)
 * — сервер их переэкспортирует, чтобы не держать вторую копию:
 *
 * - `KeySource` — откуда взят ключ: сохранён в панели, из окружения, или ключа нет.
 * - `KeyStatus` — статус ключа без раскрытия самого ключа (маска + источник + env-имя).
 * - `RunnerMode` — режим запуска ассистента активного провайдера.
 * - `RunnerReason` — причина итогового режима (машиночитаемая, для i18n на клиенте):
 *   `api_key` — есть ключ, идём в API; `cli_found` — ключа нет, но CLI провайдера
 *   найден в PATH; `no_key_no_cli` — ни ключа, ни CLI; `unsupported` — у провайдера
 *   нет модельного API и запуск через CLI не поддержан (Cursor).
 * - `ProviderKeyItem` — одна строка списка `GET /api/provider-keys`.
 */
export type { KeySource, KeyStatus, RunnerMode, RunnerReason, ProviderKeyItem };

/**
 * Резолвинг ключа провайдера по приоритету: (1) сохранённый в панели,
 * (2) стандартная переменная окружения из `apiKeyEnvVars`. Возвращает статус с
 * маской, без самого ключа.
 */
export function resolveKey(provider: ConfigProvider, appDataDir: string): KeyStatus {
  const stored = getStoredKey(appDataDir, provider.id);
  if (stored) return { present: true, source: 'stored', masked: maskKey(stored) };

  const envVars = provider.assistant?.apiKeyEnvVars ?? [];
  for (const name of envVars) {
    const value = process.env[name];
    if (value && value.trim()) {
      return { present: true, source: 'env', masked: maskKey(value), envVar: name };
    }
  }
  return { present: false, source: null, masked: '' };
}

export interface RunnerResolution {
  mode: RunnerMode;
  reason: RunnerReason;
  keyStatus: KeyStatus;
  /** Найден ли бинарь CLI провайдера в PATH (для подсказок интерфейсу). */
  cliFound: boolean;
  /**
   * Имя команды, которая РЕАЛЬНО нашлась в PATH (`codex.cmd` или `codex` — на
   * Windows CLI ставится и npm-обёрткой, и как .exe). Ею же запускается
   * one-shot ассистента, чтобы не спавнить заведомо отсутствующий `.cmd`.
   * `undefined`, когда CLI не найден.
   */
  cliCommandFound?: string;
}

/**
 * Детект бинаря CLI в PATH — ОБЩИЙ хелпер `providers/detect.ts` (Ф7). Здесь
 * он переэкспортируется, чтобы резолвинг раннера и детект провайдеров пользовались
 * ОДНОЙ реализацией (`where`/`which`, с таймаутом, никогда не бросает).
 */
export { detectCliOnPath };

/**
 * Резолвинг раннера провайдера. ПРИОРИТЕТ — ПОДПИСКА, не платный API (незыблемое
 * правило Ф6). Порядок:
 *   1. cliRunnable И бинарь CLI найден в PATH → `cli` (= вход через подписку/
 *      логин провайдера, без оплаты по токенам) — ПЕРВЫМ;
 *   2. иначе apiKind ≠ none И ключ present → `api` (платный API — ТОЛЬКО фолбэк);
 *   3. иначе → `none` (панель просит ключ; Cursor — всегда none).
 *
 * Для Claude найденный `claude` CLI → `cli` даже при наличии ключа — текущее
 * поведение чата сохраняется (регресс-ноль). `detect` инъектируется для тестов.
 */
export function resolveRunner(
  provider: ConfigProvider,
  appDataDir: string,
  detect: (command: string) => boolean = detectCliOnPath,
): RunnerResolution {
  const assistant = provider.assistant;
  const keyStatus = resolveKey(provider, appDataDir);

  // (1) Подписка через CLI провайдера — приоритетнее платного API. Перебираем все
  // имена-кандидаты (Windows: `<name>.cmd`, затем `<name>`) и запоминаем найденное.
  const cliCommandFound = assistant?.cliRunnable
    ? findCliOnPath(providerCliCandidates(provider), detect)
    : undefined;
  if (cliCommandFound !== undefined) {
    return { mode: 'cli', reason: 'cli_found', keyStatus, cliFound: true, cliCommandFound };
  }

  // (2) Платный API — только фолбэк, когда подписки/CLI нет.
  if (assistant && assistant.apiKind !== 'none' && keyStatus.present) {
    return { mode: 'api', reason: 'api_key', keyStatus, cliFound: false };
  }

  // (3) Провайдер без модельного API и без запуска через CLI (Cursor) —
  // unsupported; иначе ключа/CLI просто не нашлось.
  const unsupported = !assistant || (assistant.apiKind === 'none' && !assistant.cliRunnable);
  return {
    mode: 'none',
    reason: unsupported ? 'unsupported' : 'no_key_no_cli',
    keyStatus,
    cliFound: false,
  };
}

/**
 * Сырой (расшифрованный) ключ провайдера для прямого вызова модельного API —
 * приоритет: сохранённый в панели, затем стандартная env-переменная. Возвращает
 * `null`, если ключа нет.
 *
 * БЕЗОПАСНОСТЬ: результат используется ТОЛЬКО для исходящего запроса к API
 * провайдера и НИКОГДА не логируется и не возвращается наружу (в отличие от
 * `resolveKey`, который отдаёт лишь маску). Держать значение локально.
 */
export function getRawKey(provider: ConfigProvider, appDataDir: string): string | null {
  const stored = getStoredKey(appDataDir, provider.id);
  if (stored) return stored;
  const envVars = provider.assistant?.apiKeyEnvVars ?? [];
  for (const name of envVars) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/** Может ли провайдер держать API-ключ (apiKind ≠ none). У Cursor — нет. */
export function canHoldKey(provider: ConfigProvider): boolean {
  return provider.assistant !== undefined && provider.assistant.apiKind !== 'none';
}

// --- Сводки для роутов ------------------------------------------------------

/** Список провайдеров с их статусом ключей (для раздела настроек). */
export function describeProviderKeys(appDataDir: string): ProviderKeyItem[] {
  return listProviders().map((provider) => {
    const apiKind = provider.assistant?.apiKind ?? 'none';
    return {
      providerId: provider.id,
      providerName: provider.name,
      apiKind,
      supported: apiKind !== 'none',
      keyStatus: resolveKey(provider, appDataDir),
      envVars: provider.assistant?.apiKeyEnvVars ?? [],
    };
  });
}

/** Резолв раннера активного провайдера — для `GET /api/provider-runner`. */
export interface ActiveRunnerInfo extends RunnerResolution {
  providerId: string;
  providerName: string;
  apiKind: AssistantApiKind;
  cliRunnable: boolean;
  cliCommand: string;
}

export function describeActiveRunner(
  store: KeysSettingsSource,
  appDataDir: string,
  detect: (command: string) => boolean = detectCliOnPath,
): ActiveRunnerInfo {
  const provider = getActiveProvider(store);
  const resolution = resolveRunner(provider, appDataDir, detect);
  return {
    ...resolution,
    providerId: provider.id,
    providerName: provider.name,
    apiKind: provider.assistant?.apiKind ?? 'none',
    cliRunnable: Boolean(provider.assistant?.cliRunnable),
    // Показываем то имя, которое РЕАЛЬНО нашлось (на Windows это может быть
    // `codex` вместо `codex.cmd`); не нашлось — имя по умолчанию для этой ОС.
    cliCommand: resolution.cliCommandFound ?? providerCliCommand(provider),
  };
}

// --- Мутации ключей (валидация цели) ----------------------------------------

/** Ошибка операции с ключом — роут превращает её в 4xx с внятным текстом. */
export class ProviderKeyError extends Error {
  code: 'unknown_provider' | 'unsupported_provider' | 'invalid_key';
  constructor(code: ProviderKeyError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'ProviderKeyError';
  }
}

/** Проверить, что провайдер известен и может держать ключ; иначе бросить ошибку. */
function requireKeyableProvider(providerId: string): ConfigProvider {
  if (!isKnownProviderId(providerId)) {
    throw new ProviderKeyError('unknown_provider', `Неизвестный провайдер «${providerId}».`);
  }
  const provider = getProvider(providerId);
  if (!canHoldKey(provider)) {
    throw new ProviderKeyError(
      'unsupported_provider',
      `У провайдера «${provider.name}» нет собственного модельного API — ключ задать нельзя.`,
    );
  }
  return provider;
}

/**
 * Сохранить ключ провайдера (зашифровано). Возвращает обновлённый статус
 * (маскированный). Пустой/слишком длинный ключ → ошибка (в файл не пишем).
 */
export function saveProviderKey(appDataDir: string, providerId: string, key: string): KeyStatus {
  const provider = requireKeyableProvider(providerId);
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH) {
    throw new ProviderKeyError('invalid_key', 'Ключ пуст или превышает допустимую длину.');
  }
  setStoredKey(appDataDir, providerId, trimmed);
  return resolveKey(provider, appDataDir);
}

/** Очистить сохранённый ключ провайдера. Возвращает статус после очистки. */
export function deleteProviderKey(appDataDir: string, providerId: string): KeyStatus {
  const provider = requireKeyableProvider(providerId);
  clearStoredKey(appDataDir, providerId);
  return resolveKey(provider, appDataDir);
}

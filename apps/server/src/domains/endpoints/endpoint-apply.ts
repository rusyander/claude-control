import type { EndpointApplyResult, EndpointProfile } from '@claude-control/contracts';
import { getProvider, isKnownProviderId } from '../../providers/registry.ts';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';
import {
  readProviderEnvVars,
  resolveProviderEnvTargetFor,
  saveProviderEnvVars,
} from '../provider-env.ts';
import { buildEndpointPlan, resolveEndpointVars } from './endpoint-plan.ts';
import { isLocalHost, parseEndpointUrl } from './endpoint-probe.ts';

/**
 * Применение профиля своего эндпоинта к конфигурации выбранного CLI.
 *
 * Пишутся ровно те переменные, которые CLI объявил задокументированными
 * (`endpointConfig` в реестре), и ровно через тот механизм, которым панель уже
 * ведёт его окружение: у Claude — блок `env` в settings.json, у остальных —
 * универсальный env-раздел с хирургической правкой файла. Прочие переменные
 * пользователя не трогаются: набор читается, дополняется и записывается целиком.
 *
 * ТОКЕН по умолчанию НЕ пишется. Он уходит в файл только когда пользователь
 * поставил галочку `writeToken` у профиля, и только если токен вообще сохранён.
 * В ответе значение токена всегда замаскировано.
 */

/** Отказ применения — маршрут превращает его в 4xx с понятным текстом. */
export class EndpointApplyError extends Error {
  code: 'unknown_provider' | 'unsupported_provider' | 'invalid_base_url' | 'insecure_base_url';

  constructor(code: EndpointApplyError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'EndpointApplyError';
  }
}

/**
 * Проверка адреса ДО записи. Общая часть — схема http(s). Отдельная —
 * требование самого Gemini CLI: его переменная адреса «must use HTTPS unless
 * pointing to localhost». Записать туда обычный http значило бы оставить
 * человека с настройкой, которую CLI молча отвергнет.
 */
function assertBaseUrl(profile: EndpointProfile): void {
  const url = parseEndpointUrl(profile.baseUrl.trim());
  if (!url) {
    throw new EndpointApplyError(
      'invalid_base_url',
      'Адрес эндпоинта должен быть корректным http(s)-адресом.',
    );
  }
  if (profile.apiKind === 'google' && url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new EndpointApplyError(
      'insecure_base_url',
      'Gemini CLI принимает по своей переменной адреса только https — исключение сделано лишь для localhost.',
    );
  }
}

interface ClaudeSettingsEnv {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Записать переменные в блок `env` файла settings.json Claude.
 *
 * Почему не через `domains/env.ts`: там запись поштучная (каждый ключ — своя
 * копия файла и своя запись), а здесь набор применяется одним заходом. Богатый
 * раздел env самого Claude при этом не трогается ни на строку — незыблемое
 * правило «не ломать Claude» дороже переиспользования пяти строк.
 */
function saveClaudeEndpointEnv(
  settingsPath: string,
  vars: { key: string; value: string }[],
  backupDir: string | undefined,
): string | undefined {
  const settings = readJsonFile<ClaudeSettingsEnv>(settingsPath, {});
  const env = { ...settings.env };
  for (const { key, value } of vars) env[key] = value;
  settings.env = env;
  return writeJsonFile(settingsPath, settings, { backupDir });
}

/**
 * Применить профиль к CLI. `token` — расшифрованное значение из хранилища
 * панели; попадает в файл только при `profile.writeToken`.
 */
export function applyEndpointProfile(
  profile: EndpointProfile,
  providerId: string,
  token: string | undefined,
  paths: { claudeSettings: string; override?: string },
  backupDir: string | undefined,
): EndpointApplyResult {
  if (!isKnownProviderId(providerId)) {
    throw new EndpointApplyError('unknown_provider', `Неизвестный провайдер «${providerId}».`);
  }
  const provider = getProvider(providerId);

  const resolved = resolveEndpointVars(provider, profile.apiKind);
  if (!('vars' in resolved)) {
    throw new EndpointApplyError(
      'unsupported_provider',
      `У «${provider.name}» нет задокументированной переменной окружения для этого вида API — профиль сюда не переносится.`,
    );
  }

  assertBaseUrl(profile);

  // Один и тот же план идёт и в файл, и в ответ: в файл — с настоящим значением
  // токена, в ответ — с маской. Две сборки разошлись бы, и предпросмотр перестал
  // бы что-либо обещать.
  const write = buildEndpointPlan(profile, resolved.vars, token, false);
  const shown = buildEndpointPlan(profile, resolved.vars, token, true);

  if (provider.id === 'claude') {
    const backupPath = saveClaudeEndpointEnv(paths.claudeSettings, write, backupDir);
    return {
      providerId: provider.id,
      filePath: paths.claudeSettings,
      written: shown,
      backupPath,
    };
  }

  const target = resolveProviderEnvTargetFor(provider, paths.override);
  if (!target) {
    throw new EndpointApplyError(
      'unsupported_provider',
      `У «${provider.name}» нет раздела переменных окружения — писать некуда.`,
    );
  }

  // Существующие переменные читаются и переносятся целиком: профиль ДОПОЛНЯЕТ
  // окружение CLI, а не заменяет его. Ключи профиля перекрывают одноимённые.
  const existing = readProviderEnvVars(target);
  const merged = new Map(existing.map((item) => [item.key, item.value] as const));
  for (const { key, value } of write) merged.set(key, value);

  const backupPath = saveProviderEnvVars(
    target,
    [...merged.entries()].map(([key, value]) => ({ key, value })),
    backupDir,
  );

  return { providerId: provider.id, filePath: target.filePath, written: shown, backupPath };
}

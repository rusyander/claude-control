import { createHash } from 'node:crypto';
import type { PlatformAppliedTarget } from '@agentdeck/contracts';
import { existsSync, readFileSync } from 'node:fs';
import { readJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { readContinueModels } from '../../../lib/continue-yaml.ts';
import { parseCodexToml } from '../../../lib/codex-toml/codex-toml.ts';
import { getProvider, isKnownProviderId } from '../../../providers/registry.ts';
import type { ProviderEndpointFile } from '../../../providers/types/assistant.ts';
import {
  readProviderEnvVars,
  resolveProviderEnvTargetFor,
} from '../../provider-env/provider-env.ts';
import type { ContourTarget, ContourTargetPaths } from './targets.ts';
import { contourEntryName } from './targets.ts';

/**
 * Что стоит в чужом конфиге ПРЯМО СЕЙЧАС.
 *
 * Нужно двум разным вопросам, и оба про честность: «занято ли место» (тогда
 * панель показывает конфликт и требует явного выбора вместо тихой перезаписи) и
 * «тот ли это файл, каким мы его оставили» (тогда откат имеет право его
 * трогать). Второе считается отпечатком: сравнивать по времени изменения
 * бессмысленно — его меняет и наша собственная запись.
 */

/** sha1 файла; файла нет — пустая строка (это тоже состояние, а не ошибка). */
export function fingerprintOf(filePath: string): string {
  if (!filePath || !existsSync(filePath)) return '';
  return createHash('sha1').update(readFileSync(filePath)).digest('hex');
}

interface ClaudeSettingsEnv {
  env?: Record<string, string>;
}

/** Текущие значения переменных цели: имя → значение. Файла нет — пусто. */
export function readCurrentEnv(
  target: ContourTarget,
  paths: ContourTargetPaths,
): Map<string, string> {
  const write = target.write;
  if (write?.kind !== 'endpoint-env') return new Map();

  if (write.providerId === 'claude') {
    const settings = readJsonFile<ClaudeSettingsEnv>(paths.claudeSettings, {});
    return new Map(Object.entries(settings.env ?? {}));
  }

  const envTarget = resolveProviderEnvTargetFor(getProvider(write.providerId), paths.override);
  if (!envTarget) return new Map();
  return new Map(readProviderEnvVars(envTarget).map((item) => [item.key, item.value] as const));
}

/**
 * Текущие значения файловой цели в тех же ключах, что показывает план
 * (`model_providers.<имя>.base_url`, `models[<имя>].apiBase`). Файл не
 * разбирается — считаем, что занятого места нет: отказ произойдёт при записи,
 * fail-closed, и там он с внятным кодом, а не в предпросмотре.
 */
export function readCurrentFileValues(
  target: ContourTarget,
  platformId: string,
): Map<string, string> {
  const write = target.write;
  if (write?.kind !== 'endpoint-file') return new Map();
  return readEntryValues(write.filePath, write.file.format, platformId);
}

function readEntryValues(
  filePath: string,
  format: ProviderEndpointFile['format'],
  platformId: string,
): Map<string, string> {
  if (!existsSync(filePath)) return new Map();
  const name = contourEntryName(platformId);
  const values = new Map<string, string>();
  const text = readFileSync(filePath, 'utf8');

  try {
    if (format === 'codex-toml') {
      const parsed = parseCodexToml(text);
      const root = parsed.model_provider;
      if (typeof root === 'string') values.set('model_provider', root);

      const region = parsed.model_providers;
      const entry =
        region && typeof region === 'object' && !Array.isArray(region)
          ? (region as Record<string, unknown>)[name]
          : undefined;
      if (entry && typeof entry === 'object') {
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (typeof value === 'string') values.set(`model_providers.${name}.${key}`, value);
        }
      }
      return values;
    }

    const entry = readContinueModels(text).find((item) => item.name === name);
    for (const [key, value] of Object.entries(entry ?? {})) {
      if (typeof value === 'string') values.set(`models[${name}].${key}`, value);
    }
    return values;
  } catch {
    return new Map();
  }
}

/** Что собственный файл CLI говорит о шлюзе: уводит ли туда и какой контур называет. */
export type EndpointFileRoute = { routed: false } | { routed: true; platformId?: string };

/** Выбранный в файле провайдер или модель: имя и адрес, если он записан. */
export interface ActiveEntry {
  name: string;
  baseUrl?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Провайдеры, которые Codex возьмёт ПРЯМО СЕЙЧАС: корневой `model_provider` и
 * выбор активного профиля (`profile` → `[profiles.<имя>].model_provider`).
 * Берутся оба: какой из них перекроет другой, решает запуск, а лишнее «уводит»
 * здесь только закрывает младшую ступень, не ломая прогон.
 */
export function activeCodexEntries(parsed: Record<string, unknown>): ActiveEntry[] {
  const names = new Set<string>();
  if (typeof parsed.model_provider === 'string') names.add(parsed.model_provider);
  const profileName = parsed.profile;
  const profile =
    typeof profileName === 'string'
      ? recordOf(recordOf(parsed.profiles)?.[profileName])
      : undefined;
  if (typeof profile?.model_provider === 'string') names.add(profile.model_provider);

  const table = recordOf(parsed.model_providers);
  return [...names].map((name) => {
    const baseUrl = recordOf(table?.[name])?.base_url;
    return typeof baseUrl === 'string' ? { name, baseUrl } : { name };
  });
}

/**
 * Модели Continue — все: какую из них выберет запуск, файл не говорит, а
 * ошибка здесь допустима только в сторону «уводит».
 */
function continueEntries(text: string): ActiveEntry[] {
  return readContinueModels(text).map((model) => {
    const name = typeof model.name === 'string' ? model.name : '';
    return typeof model.apiBase === 'string' ? { name, baseUrl: model.apiBase } : { name };
  });
}

/**
 * Адрес шлюза панели — тот, что строит `gatewayUrlFor`:
 * `http://127.0.0.1:<порт>/<контур>/…`. Шлюзом считается петлевой адрес на
 * живом порту шлюза или с известным контуром первым сегментом пути (порт мог
 * смениться с тех пор, как адрес записали). Петлевой адрес на чужом порту без
 * контура — локальный сервер моделей человека, не контур.
 */
function gatewayPlatformOf(
  baseUrl: string,
  platformIds: readonly string[],
  gatewayPort: number,
): { platformId?: string } | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  const first = url.pathname.split('/').find(Boolean) ?? '';
  const known = platformIds.find((id) => id === first);
  if (known) return { platformId: known };
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return gatewayPort > 0 && port === gatewayPort ? {} : undefined;
}

function entryRoute(
  entry: ActiveEntry,
  platformIds: readonly string[],
  gatewayPort: number,
): EndpointFileRoute {
  const named = platformIds.find((id) => contourEntryName(id) === entry.name);
  if (named) return { routed: true, platformId: named };
  const viaGateway = entry.baseUrl
    ? gatewayPlatformOf(entry.baseUrl, platformIds, gatewayPort)
    : undefined;
  if (viaGateway) return { routed: true, ...viaGateway };
  // Запись контура, которого в настройках уже нет: карта неизвестна, но уводит.
  if (entry.name.startsWith(contourEntryName(''))) return { routed: true };
  return { routed: false };
}

/**
 * Запись провайдера в настройках CLI уводит в шлюз панели: имя записи контура
 * (`contour-<id>`) или адрес шлюза — та же сверка, что у `endpointFileRoute`.
 * Нужна тому, кто ищет у CLI свой локальный сервер моделей: шлюз тоже петлевой,
 * но за ним облако.
 */
export function entryRoutesToGateway(
  entry: ActiveEntry,
  platformIds: readonly string[],
  gatewayPort: number,
): boolean {
  return entryRoute(entry, platformIds, gatewayPort).routed;
}

/**
 * Уводит ли СОБСТВЕННЫЙ файл CLI (`endpointFile`: Codex `config.toml`, Continue
 * `config.yaml`) его прогоны в шлюз панели — по тому, что в файле лежит сейчас,
 * без следа применения. След врёт в обе стороны: откат оставляет правленный
 * рукой файл как есть (`kept`) и всё равно вычёркивает цель, а запись шлюза,
 * вписанную человеком, след не знает вовсе. Ошибка только в сторону «уводит»:
 * файл есть, но не читается или не разбирается — уводит, контур неизвестен.
 */
export function endpointFileRoute(
  file: ProviderEndpointFile,
  platformIds: readonly string[],
  gatewayPort: number,
): EndpointFileRoute {
  const filePath = file.path();
  if (!existsSync(filePath)) return { routed: false };
  let entries: ActiveEntry[];
  try {
    const text = readFileSync(filePath, 'utf8');
    entries =
      file.format === 'codex-toml'
        ? activeCodexEntries(parseCodexToml(text))
        : continueEntries(text);
  } catch {
    return { routed: true };
  }
  for (const entry of entries) {
    const route = entryRoute(entry, platformIds, gatewayPort);
    if (route.routed) return route;
  }
  return { routed: false };
}

type OwnedTrace = Pick<PlatformAppliedTarget, 'targetId' | 'filePath' | 'previous'>;

/**
 * Отпечаток ТОГО, ЧТО ЗАПИСАЛА ПАНЕЛЬ, а не всего файла (аудит DRV-02).
 *
 * `settings.json` Claude пишет не одно применение: права, хуки и переменные
 * панели ложатся туда же, как и правки человека в чужих разделах. Отпечаток
 * файла объявлял «чужой рукой» любую такую запись — откат уходил в `kept` и
 * оставлял CLI направленным на шлюз. Здесь в счёт идут только наши ключи:
 * переменные, которые писало применение, или своя запись контура в файле
 * (codex — своя таблица и корневой выбор провайдера, continue — своя модель).
 */
export function ownedFingerprintOf(
  trace: OwnedTrace,
  platformId: string,
  override: string | undefined,
): string {
  const entries = [...ownedValues(trace, platformId, override).entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex');
}

function ownedValues(
  trace: OwnedTrace,
  platformId: string,
  override: string | undefined,
): Map<string, string> {
  if (!trace.filePath || !existsSync(trace.filePath) || !isKnownProviderId(trace.targetId)) {
    return new Map();
  }
  const keys = new Set(trace.previous.map((item) => item.key));
  const pick = (all: Map<string, string>) => new Map([...all].filter(([key]) => keys.has(key)));

  if (trace.targetId === 'claude') {
    const settings = readJsonFile<ClaudeSettingsEnv>(trace.filePath, {});
    return pick(new Map(Object.entries(settings.env ?? {})));
  }

  const provider = getProvider(trace.targetId);
  if (provider.endpointFile && !provider.endpointConfig) {
    return readEntryValues(trace.filePath, provider.endpointFile.format, platformId);
  }

  // Путь — из следа, формат — из реестра: так же читает и сам откат.
  const resolved = resolveProviderEnvTargetFor(provider, override);
  if (!resolved) return new Map();
  const target = { ...resolved, filePath: trace.filePath };
  return pick(new Map(readProviderEnvVars(target).map((item) => [item.key, item.value] as const)));
}

/**
 * Правили ли наше место после применения. След, записанный до отпечатка по
 * ключам, сверяется по-старому — всем файлом: пересчитать то, чего тогда не
 * сохранили, нельзя, а «не правили» вместо «не знаем» стёрло бы чужую правку.
 */
export function driftedSinceApply(
  trace: OwnedTrace & Pick<PlatformAppliedTarget, 'fingerprint' | 'ownedFingerprint'>,
  platformId: string,
  override: string | undefined,
): boolean {
  if (trace.ownedFingerprint === undefined) {
    return fingerprintOf(trace.filePath) !== trace.fingerprint;
  }
  return ownedFingerprintOf(trace, platformId, override) !== trace.ownedFingerprint;
}

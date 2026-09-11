import { existsSync, readFileSync } from 'node:fs';
import { stringify as stringifyToml } from 'smol-toml';
import type { PlatformAppliedTarget } from '@agentdeck/contracts';
import {
  parseCodexToml,
  removeCodexRootScalar,
  spliceCodexTableRegion,
  stableToml,
  upsertCodexRootScalar,
} from '../../../lib/codex-toml.ts';
import { readContinueModels, writeContinueModels } from '../../../lib/continue-yaml.ts';
import { writeTextFile } from '../../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../../lib/format-errors.ts';
import { PLACEHOLDER_KEY } from './profile.ts';

/**
 * Две цели, у которых адрес живёт не в переменной окружения, а в куске
 * конфигурации: codex (`model_providers` в `config.toml`) и continue (запись в
 * списке `models` файла `config.yaml`).
 *
 * Правило одно и то же: правится РОВНО своя запись, всё остальное в файле
 * остаётся как было — у codex это гарантируется хирургией региона
 * (`lib/codex-toml.ts`), у continue — записью через `Document` библиотеки yaml с
 * перепроверкой проекции прочих ключей. И там, и там перед записью файл обязан
 * разбираться: непонятный формат — отказ, а не запись вслепую.
 *
 * Для отката хранится ПРЕЖНЯЯ своя запись (её может и не быть) и прежнее
 * значение выбранного провайдера у codex. Этого достаточно, потому что откат
 * трогает файл только когда тот байт-в-байт такой, каким мы его оставили.
 */

/** Что записано и что было до нас — половина следа применения. */
export interface FileWriteResult {
  previous: { key: string; value?: string }[];
  previousRegion?: string;
  backupPath?: string;
}

const CODEX_PREFIX = 'model_providers';
const CODEX_ROOT_KEY = 'model_provider';

function readFile(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

/** Разобранные `model_providers` — чужие записи проходят насквозь. */
function codexProviders(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = parseCodexToml(text);
  const region = parsed[CODEX_PREFIX];
  if (region === undefined) return {};
  if (!region || typeof region !== 'object' || Array.isArray(region)) {
    throw new UnrecognizedFormatError();
  }
  return { ...(region as Record<string, unknown>) };
}

/** Корневой выбор провайдера — строкой, если он там строка. */
function codexRootProvider(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const value = parseCodexToml(text)[CODEX_ROOT_KEY];
  return typeof value === 'string' ? value : undefined;
}

function writeCodex(
  filePath: string,
  original: string,
  providers: Record<string, unknown>,
  rootProvider: string | undefined,
  backupDir: string | undefined,
): string | undefined {
  const hasProviders = Object.keys(providers).length > 0;
  const block = hasProviders ? stringifyToml({ [CODEX_PREFIX]: providers }) : '';

  let next = original.trim()
    ? spliceCodexTableRegion(original, block, CODEX_PREFIX)
    : hasProviders
      ? `${block.replace(/\n+$/, '')}\n`
      : '';

  next =
    rootProvider === undefined
      ? removeCodexRootScalar(next, CODEX_ROOT_KEY)
      : upsertCodexRootScalar(next, CODEX_ROOT_KEY, rootProvider);

  // Итог обязан репарситься и давать ровно задуманное — иначе хирургия что-то
  // испортила, и писать нельзя.
  if (next.trim()) {
    const reparsed = parseCodexToml(next);
    if (stableToml(reparsed[CODEX_PREFIX] ?? {}) !== stableToml(providers)) {
      throw new UnrecognizedFormatError();
    }
    if (codexRootProvider(next) !== rootProvider) throw new UnrecognizedFormatError();
  } else if (hasProviders) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(filePath, next, { backupDir });
}

/** Записать контур в `config.toml` codex. Возвращает след для отката. */
export function applyCodexEndpoint(
  filePath: string,
  name: string,
  baseUrl: string,
  backupDir: string | undefined,
): FileWriteResult {
  const original = readFile(filePath);
  const providers = codexProviders(original);
  const previousEntry = providers[name];
  const previousRoot = codexRootProvider(original);

  providers[name] = {
    name: `Контур ${name}`,
    base_url: baseUrl,
    // `chat` — тот самый OpenAI-совместимый путь `/chat/completions`, который
    // шлюз и обслуживает.
    wire_api: 'chat',
    // Имя переменной, а не ключ: codex требует НЕПУСТОЕ значение в ней, ключ
    // подставляет шлюз, и заглушка живёт в окружении, а не в конфиге.
    env_key: 'CONTOUR_API_KEY',
  };

  const backupPath = writeCodex(filePath, original, providers, name, backupDir);
  return {
    previous: [{ key: CODEX_ROOT_KEY, ...(previousRoot ? { value: previousRoot } : {}) }],
    ...(previousEntry === undefined ? {} : { previousRegion: JSON.stringify(previousEntry) }),
    ...(backupPath ? { backupPath } : {}),
  };
}

/** Вернуть `config.toml` в прежний вид: своя запись убрана или восстановлена. */
export function rollbackCodexEndpoint(
  filePath: string,
  name: string,
  record: PlatformAppliedTarget,
  backupDir: string | undefined,
): void {
  const original = readFile(filePath);
  const providers = codexProviders(original);

  if (record.previousRegion === undefined) delete providers[name];
  else providers[name] = JSON.parse(record.previousRegion) as unknown;

  const previousRoot = record.previous.find((item) => item.key === CODEX_ROOT_KEY)?.value;
  writeCodex(filePath, original, providers, previousRoot, backupDir);
}

/** Записать контур в `config.yaml` continue: своя модель, чужие не тронуты. */
export function applyContinueEndpoint(
  filePath: string,
  name: string,
  baseUrl: string,
  model: string,
  backupDir: string | undefined,
): FileWriteResult {
  const original = readFile(filePath);
  const models = readContinueModels(original);
  const previousEntry = models.find((item) => item.name === name);

  const entry: Record<string, unknown> = {
    // Чужие поля прежней записи сохраняются: человек мог дописать своё.
    ...(previousEntry ?? {}),
    name,
    provider: 'openai',
    apiBase: baseUrl,
    ...(model ? { model } : {}),
    // Continue не стартует с пустым ключом; настоящий подставляет шлюз.
    apiKey: PLACEHOLDER_KEY,
  };

  const next = models.some((item) => item.name === name)
    ? models.map((item) => (item.name === name ? entry : item))
    : [...models, entry];

  const backupPath = writeTextFile(filePath, writeContinueModels(original, next), { backupDir });
  return {
    previous: [],
    ...(previousEntry === undefined ? {} : { previousRegion: JSON.stringify(previousEntry) }),
    ...(backupPath ? { backupPath } : {}),
  };
}

/** Вернуть `config.yaml` в прежний вид: своя модель убрана или восстановлена. */
export function rollbackContinueEndpoint(
  filePath: string,
  name: string,
  record: PlatformAppliedTarget,
  backupDir: string | undefined,
): void {
  const original = readFile(filePath);
  const models = readContinueModels(original);

  const restored =
    record.previousRegion === undefined
      ? models.filter((item) => item.name !== name)
      : models.map((item) =>
          item.name === name
            ? (JSON.parse(record.previousRegion!) as Record<string, unknown>)
            : item,
        );

  writeTextFile(filePath, writeContinueModels(original, restored), { backupDir });
}

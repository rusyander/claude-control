import { basename } from 'node:path';
import type { AppSettings, ClaudePaths } from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import { providerBackupName } from '../lib/safe-io.ts';

/**
 * Какие файлы конфигурации показывает история изменений.
 *
 * Раньше это был allowlist из четырёх файлов Claude прямо в маршруте. Панель
 * давно пишет и файлы других провайдеров (AGENTS.md / GEMINI.md, config.toml,
 * settings.json, mcp.json, opencode.json, ~/.aider.conf.yml), а их правки в
 * ленту не попадали. Здесь список собирается честно: файлы Claude ВСЕГДА
 * (регресс-ноль: тот же набор и те же имена копий) плюс файлы АКТИВНОГО
 * провайдера, если он не Claude.
 *
 * КЛЮЧЕВОЕ ОТЛИЧИЕ ФАЙЛОВ ПРОВАЙДЕРА (закреплено Ф9-10): их копии называются
 * `<id>-<basename>` (`safe-io/providerBackupName`), потому что каталог копий один
 * на всю панель, а basename совпадает (`~/.gemini/settings.json` ↔
 * `~/.claude/settings.json`). Поэтому цель ищется по ИМЕНИ КОПИИ, а не по
 * basename, и выборочный откат у них ЗАПРЕЩЁН (`canRevert:false`): восстановление
 * по basename могло бы записать чужой файл поверх конфигурации Claude.
 *
 * СЕКРЕТЫ СЮДА НЕ ПОПАДАЮТ НИКОГДА. Файл `.mcp-secrets.env`, хранилище ключей
 * провайдеров `provider-keys.enc` и его машинный секрет `provider-keys.key`
 * отсеиваются явным фильтром — даже если однажды кто-то добавит их в список
 * путей: построчный дифф раскрыл бы значения токенов в интерфейсе.
 */

/** Один отслеживаемый файл: как называется его копия и куда он ведёт. */
export interface TrackedFile {
  /**
   * Имя цели в имени копии (`<backupBase>.<метка>.bak`). У Claude — basename
   * файла, у провайдера — `<id>-<basename>`.
   */
  backupBase: string;
  /** Абсолютный путь текущего файла на диске. */
  path: string;
  /** Что показывать в ленте — basename файла (без префикса провайдера). */
  file: string;
  /** Разрешён ли выборочный откат ханка в этот файл. У файлов провайдера — нет. */
  canRevert: boolean;
  /** Id провайдера, если это его файл (у файлов Claude не задан). */
  providerId?: string;
  /** Имя провайдера для бейджа в ленте. */
  providerName?: string;
}

/**
 * Имена файлов, которые не показываем НИКОГДА, чем бы их ни назвал вызывающий:
 * секреты MCP и хранилище API-ключей провайдеров вместе с его машинным секретом.
 */
const SECRET_BASENAMES = new Set(['.mcp-secrets.env', 'provider-keys.enc', 'provider-keys.key']);

/** Является ли путь секретным файлом (по basename — каталог значения не имеет). */
export function isSecretFile(path: string): boolean {
  return SECRET_BASENAMES.has(basename(path));
}

/** Минимум настроек, нужный сборщику (без импорта AppStore). */
export interface TrackedFilesSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/**
 * Файлы Claude — прежний набор из четырёх штук и прежние имена копий, чтобы
 * лента и откат Claude работали ровно как раньше (регресс-ноль).
 */
export function claudeTrackedFiles(paths: ClaudePaths): TrackedFile[] {
  const { settings, settingsLocal, claudeMd, mcpConfig } = paths;
  return [settings, settingsLocal, claudeMd, mcpConfig].filter(not(isSecretFile)).map((path) => ({
    backupBase: basename(path),
    path,
    file: basename(path),
    canRevert: true,
  }));
}

/** Отрицание предиката — чтобы фильтр читался как «не секрет». */
function not<T>(predicate: (value: T) => boolean): (value: T) => boolean {
  return (value) => !predicate(value);
}

/**
 * Файлы АКТИВНОГО провайдера, которые панель реально редактирует. Берём только
 * разделы со статусом `ready` И заданным расположением: `planned`-раздел ничего
 * не пишет, значит и копий его файла быть не может (fail-closed, путь не гадаем).
 *
 * У Codex три раздела (MCP / env / права) живут в ОДНОМ `config.toml` — путь
 * дедуплицируется, иначе лента показала бы каждую правку трижды.
 */
export function providerTrackedFiles(store: TrackedFilesSettingsSource): TrackedFile[] {
  const provider = getActiveProvider(store);
  // Claude уже покрыт claudeTrackedFiles — второй раз не добавляем.
  if (provider.id === 'claude') return [];

  const override = store.getSettings().claudeDirOverride;
  const paths: string[] = [];

  const { capabilities } = provider;
  if (capabilities.globalInstructions === 'ready' && provider.instructionsFile) {
    paths.push(provider.instructionsFile(override));
  }
  // Инструкции могут быть устроены СПИСКОМ ССЫЛОК (Aider: ключ `read` в
  // `.aider.conf.yml`) — тогда отслеживаем сам конфиг. У Aider он совпадает с
  // env-конфигом, дедупликация ниже это учитывает.
  if (capabilities.globalInstructions === 'ready' && provider.instructionsList) {
    paths.push(provider.instructionsList.path(override));
  }
  if (capabilities.mcp === 'ready' && provider.mcpConfig) {
    paths.push(provider.mcpConfig.path(override));
  }
  if (capabilities.env === 'ready' && provider.envConfig) {
    paths.push(provider.envConfig.path(override));
  }
  if (capabilities.permissions === 'ready' && provider.permissionsConfig) {
    paths.push(provider.permissionsConfig.path(override));
  }
  // Хуки (OPENCODE-3) и npm-список плагинов (OPENCODE-4) у OpenCode лежат в том
  // же opencode.json, что MCP и права — путь дедуплицируется ниже. Каталог
  // файлов-плагинов сюда НЕ попадает: `trackedFiles` ведёт ОДИНОЧНЫЕ файлы, а не
  // каталоги произвольного размера (та же причина, по которой в истории нет
  // каталога правил Cursor).
  if (capabilities.hooks === 'ready' && provider.hooksConfig) {
    paths.push(provider.hooksConfig.path(override));
  }
  if (capabilities.plugins === 'ready' && provider.pluginsConfig?.configPath) {
    paths.push(provider.pluginsConfig.configPath(override));
  }

  return [...new Set(paths)].filter(not(isSecretFile)).map((path) => ({
    backupBase: providerBackupName(provider.id, path),
    path,
    file: basename(path),
    // Fail-closed: цель копии провайдера восстановлению не подлежит — ни целиком
    // (Ф9-10, canRestore:false), ни поханочно. Дифф показываем, писать не даём.
    canRevert: false,
    providerId: provider.id,
    providerName: provider.name,
  }));
}

/** Полный список отслеживаемых файлов: Claude + активный провайдер. */
export function trackedFiles(paths: ClaudePaths, store: TrackedFilesSettingsSource): TrackedFile[] {
  return [...claudeTrackedFiles(paths), ...providerTrackedFiles(store)];
}

import type { SearchResponse } from '@claude-control/contracts';
import { getActiveProvider } from '../../providers/registry.ts';
import { readEnvVars } from '../env.ts';
import { readHooks } from '../hooks.ts';
import { readInstructionsInfo, resolveInstructionsTarget } from '../instructions.ts';
import { readMcpServers } from '../mcp.ts';
import { readPermissions } from '../permissions.ts';
import { readInstalledPluginsCached } from '../plugins.ts';
import { readProviderEnvVars, resolveProviderEnvTarget } from '../provider-env.ts';
import { readProviderMcpServers, resolveProviderMcpTarget } from '../provider-mcp.ts';
import {
  readProviderPermissions,
  resolveProviderPermissionsTarget,
  type ProviderPermissionsValues,
} from '../provider-permissions.ts';
import { readRules } from '../rules.ts';
import { readScripts } from '../scripts.ts';
import { readSkills } from '../skills.ts';
import { MIN_QUERY_LENGTH } from './constants.ts';
import { searchEntities } from './filter.ts';
import type { ProviderSearchInputs, SearchInputs, SearchSources } from './types.ts';

/**
 * Сбор разделов читалками самих разделов и точка входа поиска. Разбор запроса и
 * фильтрация живут в `filter.ts`; здесь — только ввод-вывод и склейка.
 */

/** Пустой набор разделов Claude — база для провайдер-ветки (его читалки там не зовём). */
function emptyInputs(): SearchInputs {
  return {
    rules: [],
    hooks: [],
    skills: [],
    scripts: [],
    permissions: [],
    envVars: [],
    mcpServers: [],
    plugins: [],
  };
}

/**
 * Прочитать раздел провайдера, погасив ошибку формата. Поиск — операция чтения по
 * всей панели: битый чужой конфиг (fail-closed в своём разделе) не должен ронять
 * поиск целиком. Не прочиталось → раздела в выдаче просто нет.
 */
function readOrSkip<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Разделы АКТИВНОГО провайдера для поиска. Берутся ровно те же резолверы, что и у
 * боевых роутов, поэтому `planned`/`unsupported` разделы (и провайдер без
 * задокументированного пути) сюда не попадают — fail-closed.
 */
function collectProviderInputs(sources: SearchSources): ProviderSearchInputs | undefined {
  const { paths, store } = sources;
  const provider = getActiveProvider(store);
  if (provider.id === 'claude') return undefined;

  const instructionsTarget = resolveInstructionsTarget(store, paths.claudeMd);
  const instructions = instructionsTarget
    ? readOrSkip(() => readInstructionsInfo(instructionsTarget))
    : undefined;

  const mcpTarget = resolveProviderMcpTarget(store);
  const mcpServers = mcpTarget ? readOrSkip(() => readProviderMcpServers(mcpTarget)) : undefined;

  const envTarget = resolveProviderEnvTarget(store);
  const envVars = envTarget ? readOrSkip(() => readProviderEnvVars(envTarget)) : undefined;

  const permissionsTarget = resolveProviderPermissionsTarget(store);
  const permissions = permissionsTarget
    ? readOrSkip(() => readProviderPermissions(permissionsTarget))
    : undefined;

  return {
    providerId: provider.id,
    providerName: provider.name,
    instructions: instructions
      ? { fileName: instructions.fileName, content: instructions.content }
      : undefined,
    mcpServers: mcpServers ?? [],
    // Значения переменных отбрасываем ЗДЕСЬ, у источника: дальше по конвейеру их
    // просто нет, и утечь в сниппет им неоткуда.
    envKeys: (envVars ?? []).map((item) => item.key),
    permissions: permissions ? providerPermissionEntries(permissions) : undefined,
  };
}

/**
 * Права провайдера в виде плоских пар для поиска. Модели разные, поэтому
 * раскладку задаём здесь: Codex — два скаляра, Gemini — режим аппрувов и оба
 * списка инструментов (их имена ищутся по подстроке в склейке), Qwen Code — режим
 * аппрувов и три списка правил `permissions.*` (тоже склейкой), OpenCode — по
 * паре на инструмент (у карты шаблонов значение — склейка «шаблон: уровень»).
 */
function providerPermissionEntries(
  values: ProviderPermissionsValues,
): Array<{ key: string; value: string }> {
  if (values.kind === 'opencode') {
    return values.entries.map((entry) => ({
      key: entry.tool,
      value:
        entry.mode === 'patterns'
          ? (entry.patterns ?? []).map((rule) => `${rule.pattern}: ${rule.level}`).join(', ')
          : (entry.level ?? ''),
    }));
  }
  if (values.kind === 'gemini') {
    const entries: Array<{ key: string; value: string }> = [
      { key: 'defaultApprovalMode', value: values.approvalMode },
    ];
    if (values.coreTools.length > 0)
      entries.push({ key: 'coreTools', value: values.coreTools.join(', ') });
    if (values.excludeTools.length > 0)
      entries.push({ key: 'excludeTools', value: values.excludeTools.join(', ') });
    return entries;
  }
  if (values.kind === 'qwen') {
    const entries: Array<{ key: string; value: string }> = [
      { key: 'approvalMode', value: values.approvalMode },
    ];
    for (const list of ['allow', 'ask', 'deny'] as const) {
      if (values[list].length > 0) entries.push({ key: list, value: values[list].join(', ') });
    }
    return entries;
  }
  if (values.kind === 'continue') {
    // У Continue режима нет — только три списка правил.
    const entries: Array<{ key: string; value: string }> = [];
    for (const list of ['allow', 'ask', 'exclude'] as const) {
      if (values[list].length > 0) entries.push({ key: list, value: values[list].join(', ') });
    }
    return entries;
  }
  if (values.kind === 'cursor') {
    // У Cursor режима нет — ровно два списка правил, `deny` сильнее `allow`.
    const entries: Array<{ key: string; value: string }> = [];
    for (const list of ['allow', 'deny'] as const) {
      if (values[list].length > 0) entries.push({ key: list, value: values[list].join(', ') });
    }
    return entries;
  }
  // У Goose, наоборот, списков нет вовсе — только один режим.
  if (values.kind === 'goose') return [{ key: 'GOOSE_MODE', value: values.mode }];
  if (values.kind === 'kimi') {
    // У Kimi правило несёт решение внутри себя — индексируем «решение: шаблон».
    const entries: Array<{ key: string; value: string }> = [
      { key: 'default_permission_mode', value: values.mode },
    ];
    for (const rule of values.rules) {
      entries.push({ key: 'permission.rules', value: `${rule.decision}: ${rule.pattern}` });
    }
    return entries;
  }
  return [
    { key: 'approvalPolicy', value: values.approvalPolicy },
    { key: 'sandboxMode', value: values.sandboxMode },
  ];
}

/**
 * Собирает разделы АКТИВНОГО провайдера их же читалками. Плагины идут через CLI и
 * потому асинхронны. Claude активен → прежний набор разделов без изменений;
 * иначе читалки Claude не вызываются вовсе (его конфигурация не при чём).
 */
export async function collectSearchInputs(sources: SearchSources): Promise<SearchInputs> {
  const { paths, store } = sources;

  if (getActiveProvider(store).id !== 'claude') {
    return { ...emptyInputs(), provider: collectProviderInputs(sources) };
  }

  const hooks = readHooks(paths.settings, store, paths.settingsLocal);
  const usedScriptPaths = hooks
    .map((hook) => hook.scriptPath)
    .filter((path): path is string => Boolean(path));

  // Каталог плагинов вызывает CLI Claude Code; читалка сама гасит ошибки и
  // отдаёт пустой список, поэтому недоступный CLI не роняет весь поиск. Здесь
  // берётся кэширующая читалка: поиск дёргается на каждую паузу в наборе, а
  // запуск CLI ради одной строки выдачи и был главной ценой запроса.
  const installed = await readInstalledPluginsCached();

  return {
    rules: readRules(paths.claudeMd, store),
    hooks,
    skills: readSkills(paths.skills, store),
    scripts: readScripts(paths.hooks, usedScriptPaths),
    permissions: readPermissions(paths.settings, store, paths.settingsLocal),
    envVars: readEnvVars(paths.settings, paths.secretsEnv, paths.settingsLocal),
    mcpServers: readMcpServers(paths.mcpConfig, store),
    plugins: installed,
  };
}

/**
 * Поиск по всей конфигурации. Короткий запрос сразу возвращает пустой результат,
 * не читая диск и не трогая CLI.
 */
export async function searchConfig(sources: SearchSources, query: string): Promise<SearchResponse> {
  const normalized = (query ?? '').trim();
  if (normalized.length < MIN_QUERY_LENGTH) return { query: normalized, results: [] };

  const inputs = await collectSearchInputs(sources);
  return { query: normalized, results: searchEntities(inputs, normalized) };
}

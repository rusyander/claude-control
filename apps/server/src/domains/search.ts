import type {
  ClaudePaths,
  EnvVar,
  Hook,
  McpServer,
  PermissionRule,
  Plugin,
  Rule,
  SearchResponse,
  SearchResult,
  SearchResultKind,
  Skill,
  UniversalMcpServer,
} from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { getActiveProvider } from '../providers/registry.ts';
import { readRules } from './rules.ts';
import { readHooks } from './hooks.ts';
import { readSkills } from './skills.ts';
import { readMcpServers } from './mcp.ts';
import { readPermissions } from './permissions.ts';
import { readEnvVars } from './env.ts';
import { readScripts, type ScriptFile } from './scripts.ts';
import { readPlugins } from './plugins.ts';
import { readInstructionsInfo, resolveInstructionsTarget } from './instructions.ts';
import { readProviderMcpServers, resolveProviderMcpTarget } from './provider-mcp.ts';
import { readProviderEnvVars, resolveProviderEnvTarget } from './provider-env.ts';
import {
  readProviderPermissions,
  resolveProviderPermissionsTarget,
  type ProviderPermissionsValues,
} from './provider-permissions.ts';

/**
 * Глобальный поиск по разделам конфигурации. Логика фильтрации вынесена в чистую
 * `searchEntities` — её можно проверить на собранных руками данных без чтения
 * диска и запуска CLI. `searchConfig` только собирает разделы их же читалками и
 * зовёт фильтр.
 *
 * ПОИСК ИДЁТ ПО АКТИВНОМУ ПРОВАЙДЕРУ. Claude активен → всё ровно как раньше
 * (правила, скиллы, хуки, скрипты, права, env, MCP, плагины). Выбран другой
 * провайдер → его разделы: файл инструкций (AGENTS.md/GEMINI.md), MCP-серверы,
 * переменные окружения, права — и только те, у кого статус `ready`. Иначе
 * результат вёл бы на страницу, скрытую гейтингом, а читалки Claude показывали бы
 * конфигурацию не того инструмента.
 *
 * СЕКРЕТЫ СЮДА НЕ ПОПАДАЮТ. По переменным окружения (и Claude, и провайдера) ищем
 * и показываем ТОЛЬКО имя ключа — значение, даже замаскированное, в результат не
 * уходит. Файл `.mcp-secrets.env`, хранилище ключей `provider-keys.enc` и его
 * машинный секрет `provider-keys.key` не читаются поиском вовсе.
 */

/** Короче двух символов запрос неинформативен — такой поиск не запускаем. */
const MIN_QUERY_LENGTH = 2;

/** Раздел → путь его страницы (без ведущего слэша): клиент открывает `/<pagePath>?id=<id>`. */
const PAGE_PATH: Record<SearchResultKind, string> = {
  rule: 'rules',
  skill: 'skills',
  hook: 'hooks',
  script: 'scripts',
  permission: 'permissions',
  env: 'env',
  mcp: 'mcp',
  plugin: 'plugins',
  // Раздел глобальных инструкций живёт на том же пути у всех провайдеров —
  // страница сама роутится по активному (CLAUDE.md / AGENTS.md / GEMINI.md).
  instructions: 'claude-md',
};

/**
 * Разделы АКТИВНОГО провайдера (не Claude), которые панель реально редактирует.
 * Значения переменных окружения сюда НЕ кладём — только имена ключей.
 */
export interface ProviderSearchInputs {
  providerId: string;
  providerName: string;
  /** Файл глобальных инструкций: имя и содержимое (ищем по тексту). */
  instructions?: { fileName: string; content: string };
  mcpServers: UniversalMcpServer[];
  /** ТОЛЬКО имена ключей: значения переменных в индекс поиска не попадают. */
  envKeys: string[];
  /**
   * Права провайдера как плоские пары «ключ → значение»: модели у CLI разные
   * (Codex — approval/sandbox, Gemini — режим аппрувов и списки инструментов),
   * а поиску нужен один общий вид.
   */
  permissions?: Array<{ key: string; value: string }>;
}

/** Собранные разделы. Держим их отдельным типом, чтобы фильтр не зависел от источника данных. */
export interface SearchInputs {
  rules: Rule[];
  hooks: Hook[];
  skills: Skill[];
  scripts: ScriptFile[];
  permissions: PermissionRule[];
  envVars: EnvVar[];
  mcpServers: McpServer[];
  plugins: Plugin[];
  /** Разделы активного провайдера — задано, только когда активен НЕ Claude. */
  provider?: ProviderSearchInputs;
}

/** Совпадает ли хоть одно из полей с запросом (без учёта регистра). */
function matchesAny(fields: Array<string | undefined>, needle: string): boolean {
  return fields.some((field) => field != null && field.toLowerCase().includes(needle));
}

/**
 * Фрагмент вокруг места совпадения: схлопываем пробелы и переносы, вырезаем окно
 * с запасом по краям и добавляем многоточия. Если совпадения в тексте нет
 * (искали по другому полю), показываем начало первого непустого поля.
 */
function buildSnippet(fields: Array<string | undefined>, needle: string, radius = 40): string {
  const texts = fields
    .map((field) => (field ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0);

  const hit = texts.find((text) => text.toLowerCase().includes(needle));
  const source = hit ?? texts[0] ?? '';
  if (!source) return '';

  if (!hit) return source.length > radius * 2 ? `${source.slice(0, radius * 2)}…` : source;

  const at = source.toLowerCase().indexOf(needle);
  const start = Math.max(0, at - radius);
  const end = Math.min(source.length, at + needle.length + radius);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

/**
 * Чистая фильтрация уже собранных разделов по запросу. Регистр не учитывается,
 * пустой/короткий запрос даёт пустой список. Порядок результатов — по разделам,
 * в том же порядке, что и разделы навигации.
 */
export function searchEntities(inputs: SearchInputs, query: string): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY_LENGTH) return [];

  const results: SearchResult[] = [];
  const push = (kind: SearchResultKind, id: string, title: string, snippet: string): void => {
    results.push({ kind, id, title, snippet, pagePath: PAGE_PATH[kind] });
  };

  // Правила: заголовок и тело.
  for (const rule of inputs.rules) {
    if (matchesAny([rule.title, rule.body], needle)) {
      push('rule', rule.id, rule.title, buildSnippet([rule.body, rule.title], needle));
    }
  }

  // Скиллы: идентификатор, имя, описание, тело.
  for (const skill of inputs.skills) {
    if (matchesAny([skill.id, skill.name, skill.description, skill.body], needle)) {
      push('skill', skill.id, skill.name, buildSnippet([skill.description, skill.body], needle));
    }
  }

  // Хуки: событие, matcher, команда, описание из шапки скрипта.
  for (const hook of inputs.hooks) {
    if (matchesAny([hook.event, hook.matcher, hook.command, hook.description], needle)) {
      const title = hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event;
      push('hook', hook.id, title, buildSnippet([hook.command, hook.description], needle));
    }
  }

  // Скрипты: путь/имя файла и описание из шапки.
  for (const script of inputs.scripts) {
    if (matchesAny([script.name, script.id, script.description], needle)) {
      push(
        'script',
        script.id,
        script.name,
        buildSnippet([script.description, script.name], needle),
      );
    }
  }

  // Права доступа: паттерн, решение, сервер и инструмент MCP.
  for (const rule of inputs.permissions) {
    if (matchesAny([rule.pattern, rule.decision, rule.mcpServer, rule.mcpTool], needle)) {
      push('permission', rule.id, rule.pattern, `${rule.decision}: ${rule.pattern}`);
    }
  }

  // Переменные окружения: ТОЛЬКО имя ключа. Значение (в т.ч. секрет) не ищем и не показываем.
  for (const envVar of inputs.envVars) {
    if (matchesAny([envVar.key], needle)) {
      push('env', envVar.id, envVar.key, envVar.key);
    }
  }

  // MCP-серверы: имя, команда, адрес, аргументы, транспорт.
  for (const server of inputs.mcpServers) {
    if (
      matchesAny(
        [server.name, server.command, server.url, server.transport, ...server.args],
        needle,
      )
    ) {
      push(
        'mcp',
        server.id,
        server.name,
        buildSnippet([server.command, server.url, server.name], needle),
      );
    }
  }

  // Плагины: идентификатор, имя, маркетплейс, описание.
  for (const plugin of inputs.plugins) {
    if (matchesAny([plugin.id, plugin.name, plugin.marketplace, plugin.description], needle)) {
      push('plugin', plugin.id, plugin.name, buildSnippet([plugin.description, plugin.id], needle));
    }
  }

  // Разделы активного провайдера (не Claude): те же виды результатов и те же
  // страницы — страницы сами роутятся по провайдеру, поэтому ссылки рабочие.
  const provider = inputs.provider;
  if (provider) {
    // Файл глобальных инструкций (AGENTS.md / GEMINI.md): ищем по имени и тексту.
    const instructions = provider.instructions;
    if (instructions && matchesAny([instructions.fileName, instructions.content], needle)) {
      push(
        'instructions',
        instructions.fileName,
        instructions.fileName,
        buildSnippet([instructions.content, instructions.fileName], needle),
      );
    }

    // MCP-серверы провайдера: имя, команда, адрес, аргументы, транспорт.
    for (const server of provider.mcpServers) {
      if (
        matchesAny(
          [server.name, server.command, server.url, server.transport, ...server.args],
          needle,
        )
      ) {
        push(
          'mcp',
          server.name,
          server.name,
          buildSnippet([server.command, server.url, server.name], needle),
        );
      }
    }

    // Переменные окружения провайдера: ТОЛЬКО имя ключа (значения нет и в inputs).
    for (const key of provider.envKeys) {
      if (matchesAny([key], needle)) push('env', key, key, key);
    }

    // Права провайдера: плоские пары — ищем и по имени ключа, и по значению.
    for (const { key, value } of provider.permissions ?? []) {
      if (matchesAny([key, value], needle)) push('permission', key, key, `${key}: ${value}`);
    }
  }

  return results;
}

/** Откуда читать разделы — пути конфигурации и хранилище состояния панели. */
export interface SearchSources {
  paths: ClaudePaths;
  store: AppStore;
}

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
 * списка инструментов (их имена ищутся по подстроке в склейке), OpenCode — по
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
  // отдаёт пустой список, поэтому недоступный CLI не роняет весь поиск.
  const { installed } = await readPlugins(paths.root);

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

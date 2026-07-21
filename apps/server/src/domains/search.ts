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
} from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { readRules } from './rules.ts';
import { readHooks } from './hooks.ts';
import { readSkills } from './skills.ts';
import { readMcpServers } from './mcp.ts';
import { readPermissions } from './permissions.ts';
import { readEnvVars } from './env.ts';
import { readScripts, type ScriptFile } from './scripts.ts';
import { readPlugins } from './plugins.ts';

/**
 * Глобальный поиск по разделам конфигурации. Логика фильтрации вынесена в чистую
 * `searchEntities` — её можно проверить на собранных руками данных без чтения
 * диска и запуска CLI. `searchConfig` только собирает разделы их же читалками и
 * зовёт фильтр.
 *
 * Секреты сюда не попадают: по переменным окружения ищем и показываем ТОЛЬКО имя
 * ключа, значение (даже замаскированное) в результат не уходит.
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
};

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

  return results;
}

/** Откуда читать разделы — пути конфигурации и хранилище состояния панели. */
export interface SearchSources {
  paths: ClaudePaths;
  store: AppStore;
}

/** Собирает все разделы их же читалками. Плагины идут через CLI и потому асинхронны. */
export async function collectSearchInputs(sources: SearchSources): Promise<SearchInputs> {
  const { paths, store } = sources;

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

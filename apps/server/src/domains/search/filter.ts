import type { SearchResult, SearchResultKind } from '@claude-control/contracts';
import { MIN_QUERY_LENGTH, PAGE_PATH } from './constants.ts';
import type { SearchInputs } from './types.ts';

/**
 * Чистая фильтрация уже собранных разделов: ни диска, ни CLI — только данные и
 * запрос. Поэтому её можно проверить на собранных руками входах.
 */

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

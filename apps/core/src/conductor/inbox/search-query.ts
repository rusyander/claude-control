import { quoteJql } from '@agentdeck/trackers/jira';
import type { InboxRead } from './kind.ts';

/**
 * Запрос поиска человека → что спросить у источника (этап 12, P167, ревью волны 2). Поле поиска
 * панели обещает «ключ задачи или слова из названия» и JQL. Голый ключ или слова, отправленные
 * трекеру как JQL, — отказ 400, и человек видел «неизвестно» вместо своего тикета. Поэтому:
 * - только ключи задач (`PROJ-12`, через пробел или запятую) → `key = "…"` / `key in (…)`;
 * - есть оператор JQL (`=`, `~`, `<`, `>`, `in (`, `is empty`, `order by`) → JQL как есть;
 * - иначе слова → `text ~ "…"` (полнотекстовый поиск самого трекера).
 * Запрос остаётся данными для трекера: через модель он не идёт.
 */

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const JQL_OPERATOR = /[=~<>]|\bnot\s+in\s*\(|\bin\s*\(|\bis\s+(?:not\s+)?empty\b|\border\s+by\b/i;

/** JQL поиска Jira по запросу человека; пустой запрос — `null` (решает сохранённый запрос источника). */
export function searchJqlOf(q: string): string | null {
  const text = q.trim();
  if (!text) return null;
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.every((t) => ISSUE_KEY.test(t))) {
    const keys = [...new Set(tokens.map((t) => t.toUpperCase()))].map(quoteJql);
    return keys.length === 1 ? `key = ${keys[0]}` : `key in (${keys.join(', ')})`;
  }
  if (JQL_OPERATOR.test(text)) return text;
  return `text ~ ${quoteJql(text)}`;
}

/** Поиск по прочитанным спискам форжа: своего языка запросов нет — ключ или заголовок. */
export function matchesForgeQuery(read: InboxRead, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();
  if (!needle) return true;
  return (
    read.item.title.toLowerCase().includes(needle) || read.item.key.toLowerCase().includes(needle)
  );
}

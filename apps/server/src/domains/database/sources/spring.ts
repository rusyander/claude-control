import { parseAllDocuments } from 'yaml';
import type { ParsedTarget } from '../database.types.ts';
import { parseDatabaseUrl } from './url.ts';

/**
 * Spring Boot: `spring.datasource.url` (JDBC) или `spring.r2dbc.url` плюс
 * `username`/`password` рядом. Значения часто — подстановки `${DB_HOST:localhost}`:
 * переменную берём из `.env` проекта, иначе значение после двоеточия.
 */

/** Плоские ключи `a.b.c` → значение, из .properties. */
export function readProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const match = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (match?.[1]) props[match[1]] = match[2] ?? '';
  }
  return props;
}

/** Плоские ключи из YAML: все документы файла (`---`), последний побеждает. */
export function readYamlProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  const walk = (node: unknown, prefix: string): void => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, prefix ? `${prefix}.${key}` : key);
      }
    } else if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      props[prefix] = String(node);
    }
  };
  try {
    for (const doc of parseAllDocuments(text)) {
      if (!('errors' in doc) || doc.errors.length > 0) continue;
      walk(doc.toJS(), '');
    }
  } catch {
    // Чужой YAML с ошибкой — не повод ронять поиск баз.
  }
  return props;
}

/** `${DB_HOST:localhost}` → из переменных или значение по умолчанию; нечем раскрыть — `undefined`. */
export function resolvePlaceholders(
  value: string,
  vars: Record<string, string>,
): string | undefined {
  let unresolved = false;
  const out = value.replace(
    /\$\{([^}:]+)(?::([^}]*))?\}/g,
    (_all, name: string, fallback?: string) => {
      const found = vars[name.trim()];
      if (found !== undefined) return found;
      if (fallback !== undefined) return fallback;
      unresolved = true;
      return '';
    },
  );
  return unresolved ? undefined : out;
}

/** База из свойств Spring. `undefined` — datasource не настроен или адрес не раскрыть. */
export function findInSpring(
  props: Record<string, string>,
  vars: Record<string, string>,
): ParsedTarget | undefined {
  for (const base of ['spring.datasource', 'spring.r2dbc']) {
    const rawUrl = props[`${base}.url`];
    if (!rawUrl) continue;
    const url = resolvePlaceholders(rawUrl, vars);
    if (!url) continue;
    const parsed = parseDatabaseUrl(url);
    if (!parsed || parsed.kind !== 'postgres') return parsed;
    const user = props[`${base}.username`];
    const password = props[`${base}.password`];
    const resolvedUser = user === undefined ? undefined : resolvePlaceholders(user, vars);
    const resolvedPassword =
      password === undefined ? undefined : resolvePlaceholders(password, vars);
    if (resolvedUser) parsed.target.user = resolvedUser;
    if (resolvedPassword) parsed.target.password = resolvedPassword;
    return parsed;
  }
  return undefined;
}

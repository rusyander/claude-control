import { hostname } from 'node:os';

/**
 * Административная доля этой машины: `\\<host>\C$\x` — тот же файл, что `C:\x`. Правила запрета
 * пути у CLI сравнивают строку, а не файл, поэтому доля пишется своей формой у каждого CLI
 * (core-s2 F-126, verify-cli V4). Здесь — имена хоста, под которыми доля указывает на эту машину.
 */
export function localShareHosts(): string[] {
  return [...new Set(['localhost', '127.0.0.1', hostname().toLowerCase()].filter(Boolean))];
}

/** Шаблон любого регистра для сравнения с учётом регистра: `aB1` → `[Aa][Bb]1`. */
export function caselessGlob(value: string): string {
  let out = '';
  for (const c of value) out += /[A-Za-z]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c;
  return out;
}

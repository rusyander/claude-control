import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { KitItemKind } from '@agentdeck/contracts/kit';

/**
 * Что лежит в наборе: файлы, которые человек видит строками на странице.
 *
 * Элемент — ОДИН файл: навык — его `SKILL.md` (соседние файлы навыка едут с
 * ним), команда и правило — свой `.md`, хук — свой `.mjs` и общий
 * `hooks.json`. Манифест плагина элементом не считается: его правка ломала
 * бы подключение целиком, а сказать человеку там нечего.
 */

export interface KitFile {
  id: string;
  kind: KitItemKind;
  name: string;
}

const PATTERNS: { kind: KitItemKind; re: RegExp }[] = [
  { kind: 'skill', re: /^skills\/([^/]+)\/SKILL\.md$/ },
  { kind: 'command', re: /^commands\/([^/]+)\.md$/ },
  { kind: 'agent', re: /^agents\/([^/]+)\.md$/ },
  { kind: 'rule', re: /^rules\/([^/]+)\.md$/ },
  { kind: 'hook', re: /^hooks\/([^/]+\.(?:mjs|json))$/ },
];

/** Все файлы каталога, пути через `/`, по алфавиту. */
export function listFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function classify(id: string): KitFile | null {
  for (const { kind, re } of PATTERNS) {
    const match = re.exec(id);
    if (match?.[1]) return { id, kind, name: match[1].replace(/\.md$/, '') };
  }
  return null;
}

export function kitFiles(dir: string): KitFile[] {
  return listFiles(dir)
    .map(classify)
    .filter((file): file is KitFile => file !== null);
}

/**
 * Строка описания: `description:` из шапки, иначе первая содержательная строка
 * (у скрипта хука — первый комментарий после шебанга).
 */
export function describe(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fromFront = front?.[1] ? /^description:\s*(.+)$/m.exec(front[1])?.[1] : undefined;
  // YAML-кавычки — синтаксис шапки, а не текст: на странице их быть не должно.
  if (fromFront) return fromFront.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  // У JSON (`hooks.json`) описания нет: первая «строка» была бы его синтаксисом.
  if (/^\s*[{[]/.test(text)) return '';
  // Шапка без description пропускается целиком — иначе строкой описания стал бы `name: …`.
  const body = front ? text.slice(front[0].length) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#!') || line === '---' || line.startsWith('{')) continue;
    if (line.startsWith('//')) return line.replace(/^\/\/\s*/, '');
    if (line.startsWith('#')) continue;
    return line.replace(/^[-*]\s*/, '');
  }
  return '';
}

export function readText(path: string): string {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

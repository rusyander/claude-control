import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Сжатие инструкций по кускам — гибрид: кусок едет сжатым, только пока сжатие
 * сделано с ТЕКУЩЕГО текста командного оригинала. Команда поменяла раздел —
 * его новая версия встаёт в слой дословно в тот же запуск, а сжатие помечено
 * «ждёт пересжатия». Качество не падает ни на один запуск; экономия догоняет.
 *
 * Кусок — раздел `## …` (всё до первого такого заголовка — преамбула). Сжатый
 * файл лежит в `.agent/local-layer/compressed/*.md` и несёт шапку:
 *
 *     ---
 *     source: CLAUDE.md            # путь от корня проекта
 *     section: "## Правила"        # строка заголовка; преамбула — "(preamble)"
 *     sha: 1a2b3c4d5e6f7a8b        # sectionSha оригинального куска
 *     ---
 */

export const PREAMBLE = '(preamble)';

export interface Section {
  heading: string;
  text: string;
}

export interface Compressed {
  file: string;
  source: string;
  section: string;
  sha: string;
  text: string;
}

/** Текст без различий концов строк и хвостовых пробелов — сравнивается смысл, не редактор. */
export function sectionSha(text: string): string {
  const normal = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return createHash('sha256').update(normal).digest('hex').slice(0, 16);
}

export function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let heading = PREAMBLE;
  let body: string[] = [];
  let fenced = false;
  const flush = (): void => {
    const joined = body.join('\n');
    if (heading !== PREAMBLE || joined.trim()) sections.push({ heading, text: joined });
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) {
      flush();
      heading = line.trim();
      body = [line];
    } else body.push(line);
  }
  flush();
  return sections;
}

function field(head: string, name: string): string | undefined {
  const match = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm').exec(head);
  if (!match) return undefined;
  const value = (match[1] as string).replace(/\s+#.*$/, '').trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] as string) : value;
}

export function readCompressed(dir: string): Compressed[] {
  if (!existsSync(dir)) return [];
  const out: Compressed[] = [];
  for (const name of readdirSync(dir)
    .filter((item) => item.endsWith('.md'))
    .sort()) {
    const file = join(dir, name);
    const raw = readFileSync(file, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (!match) continue;
    const head = match[1] as string;
    const source = field(head, 'source');
    const section = field(head, 'section');
    const sha = field(head, 'sha');
    if (!source || !section || !sha) continue;
    out.push({
      file,
      source: source.replaceAll('\\', '/'),
      section,
      sha,
      text: raw.slice(match[0].length),
    });
  }
  return out;
}

export interface Substituted {
  text: string;
  sections: number;
  compressed: number;
  /** `source#section` кусков, чьё сжатие устарело. */
  pending: string[];
  /** Сжатые файлы, нашедшие свой кусок (по любому sha). */
  matched: Set<string>;
}

/** Текст файла инструкций с подставленными сжатыми кусками, где они свежие. */
export function substitute(
  source: string,
  text: string,
  compressed: readonly Compressed[],
): Substituted {
  const sections = splitSections(text);
  // Ни одного сжатого куска у файла — он едет байт в байт, без пересборки по разделам.
  if (!compressed.some((item) => item.source === source)) {
    return { text, sections: sections.length, compressed: 0, pending: [], matched: new Set() };
  }
  const matched = new Set<string>();
  const pending: string[] = [];
  let used = 0;
  const parts = sections.map((section) => {
    const candidates = compressed.filter(
      (item) => item.source === source && item.section === section.heading,
    );
    for (const item of candidates) matched.add(item.file);
    const fresh = candidates.find((item) => item.sha === sectionSha(section.text));
    if (fresh) {
      used += 1;
      return fresh.text.trim();
    }
    if (candidates.length > 0) pending.push(`${source} → ${section.heading}`);
    return section.text.trim();
  });
  return {
    text: parts.join('\n\n'),
    sections: sections.length,
    compressed: used,
    pending,
    matched,
  };
}

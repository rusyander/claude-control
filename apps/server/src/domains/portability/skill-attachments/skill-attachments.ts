import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { SkillAttachment, SkillAttachmentSkip } from '@agentdeck/contracts/portable-env';

/**
 * Поддерево скилла — опись, а не содержимое.
 *
 * Скилл это КАТАЛОГ: `references/` со справкой, `scripts/` с кодом, вложенные
 * файлы. Скилл, доехавший одним `SKILL.md`, у цели ссылается на файлы, которых
 * там нет, — то есть выглядит перенесённым и не работает. Здесь собирается
 * опись поддерева: путь, размер и sha256 каждого файла; содержимое эмиттер
 * копирует из каталога-источника в момент записи (перенос идёт на одной машине,
 * §П2.6 — перенос на другую это `env-transfer` с его правилами путей).
 *
 * Потолок назван двумя числами, и превышение называется ФАЙЛАМИ: фраза «часть
 * вложений не влезла» человеку бесполезна — он не знает, чего лишился.
 */

/** Потолок на один файл вложения. */
export const ATTACHMENT_FILE_LIMIT = 1024 * 1024;

/** Потолок на весь скилл: сумма того, что уже выбрано описью. */
export const ATTACHMENT_SKILL_LIMIT = 5 * 1024 * 1024;

/** Файл, который каталогом скилла НЕ считается вложением: он и есть сам скилл. */
const SKILL_FILE = 'SKILL.md';

/**
 * Насколько глубоко обходим. Ограничение не от вкуса: каталог с циклической
 * ссылкой внутри себя иначе обходился бы вечно, а `realpath` ловит не всякий
 * цикл на сетевых дисках.
 */
const MAX_DEPTH = 16;

export interface SkillAttachments {
  attachments: SkillAttachment[];
  skipped: SkillAttachmentSkip[];
}

/**
 * Опись вложений каталога скилла. Обход ДЕТЕРМИНИРОВАН (имена сортируются):
 * потолок должен выбирать одни и те же файлы при каждом чтении, иначе паспорт
 * одного и того же дома менял бы отпечаток от порядка записей в ФС.
 */
export function readSkillAttachments(dir: string | null): SkillAttachments {
  const result: SkillAttachments = { attachments: [], skipped: [] };
  if (!dir) return result;

  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    // Каталога нет — это не вложения без причины, а скилл без каталога: о нём
    // уже сказано происхождением записи.
    return result;
  }

  let used = 0;
  const walk = (current: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(current).sort();
    } catch {
      result.skipped.push({ path: relativePath(root, current), bytes: 0, reason: 'not_readable' });
      return;
    }

    for (const name of names) {
      const full = join(current, name);
      const path = relativePath(root, full);
      if (path === SKILL_FILE) continue;

      let real: string;
      let stat: ReturnType<typeof statSync>;
      try {
        // `realpath` до `stat`: ссылка, ведущая за пределы каталога скилла,
        // увезла бы к цели чужое дерево — и человек узнал бы об этом по
        // размеру переноса, а не из описи.
        real = realpathSync(full);
        stat = statSync(real);
      } catch {
        result.skipped.push({ path, bytes: 0, reason: 'not_readable' });
        continue;
      }

      if (!isInside(root, real)) {
        result.skipped.push({ path, bytes: 0, reason: 'link_outside' });
        continue;
      }

      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) {
          result.skipped.push({ path, bytes: 0, reason: 'not_readable' });
          continue;
        }
        walk(full, depth + 1);
        continue;
      }

      if (!stat.isFile()) {
        // Сокет, устройство, именованный канал: копировать такое нечем, и
        // молчать о нём нельзя.
        result.skipped.push({ path, bytes: 0, reason: 'not_readable' });
        continue;
      }

      const bytes = stat.size;
      if (bytes > ATTACHMENT_FILE_LIMIT) {
        result.skipped.push({ path, bytes, reason: 'file_too_large' });
        continue;
      }
      if (used + bytes > ATTACHMENT_SKILL_LIMIT) {
        result.skipped.push({ path, bytes, reason: 'skill_too_large' });
        continue;
      }

      let sha256: string;
      try {
        sha256 = createHash('sha256').update(readFileSync(real)).digest('hex');
      } catch {
        result.skipped.push({ path, bytes, reason: 'not_readable' });
        continue;
      }

      used += bytes;
      result.attachments.push({ path, bytes, sha256 });
    }
  };

  walk(root, 0);
  return result;
}

/** Путь внутри скилла: разделитель всегда `/`, чтобы опись не зависела от ОС. */
function relativePath(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}

/** Лежит ли разрешённый путь внутри каталога скилла. */
function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

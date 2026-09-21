import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHMENT_FILE_LIMIT,
  ATTACHMENT_SKILL_LIMIT,
  readSkillAttachments,
} from './skill-attachments.ts';

/**
 * Опись вложений скилла (П2.6): каталог, а не один `SKILL.md`.
 *
 * Проверка идёт по НАСТОЯЩЕМУ дереву во временном каталоге: потолки, порядок
 * обхода и отказ от чужого дерева — всё это свойства файловой системы, и
 * рукотворный список файлов, поданный прямо в потолок, доказал бы таблицу, а не
 * чтение.
 */

let root: string;
/** Каталог ВНЕ скилла — цель ссылки, которую опись обязана отвергнуть. */
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-attachments-'));
  outside = mkdtempSync(join(tmpdir(), 'skill-outside-'));
  writeFileSync(join(outside, 'чужое.md'), 'чужое дерево', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Каталог скилла с заданными файлами; возвращает его путь. */
function skillDir(name: string, files: Record<string, string | Buffer>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('опись вложений скилла', () => {
  it('везёт всё поддерево, кроме самого SKILL.md, и путями через «/»', () => {
    const dir = skillDir('полный', {
      'SKILL.md': '---\nname: полный\n---\n',
      'references/styles.md': 'стили',
      'references/вложенно/ещё.md': 'ещё',
      'scripts/run.mjs': 'console.log(1)',
    });

    const read = readSkillAttachments(dir);
    expect(read.skipped).toEqual([]);
    expect(read.attachments.map((file) => file.path)).toEqual([
      'references/styles.md',
      'references/вложенно/ещё.md',
      'scripts/run.mjs',
    ]);
    // Сумма файла — настоящая: по ней эмиттер и человек узнают, что доехало
    // именно то, что лежало у источника.
    const styles = read.attachments.find((file) => file.path === 'references/styles.md');
    expect(styles?.sha256).toBe(createHash('sha256').update('стили').digest('hex'));
    expect(styles?.bytes).toBe(Buffer.byteLength('стили'));
  });

  it('каталога нет — это не вложения без причины, а пустая опись', () => {
    expect(readSkillAttachments(null)).toEqual({ attachments: [], skipped: [] });
    expect(readSkillAttachments(join(root, 'которого-нет'))).toEqual({
      attachments: [],
      skipped: [],
    });
  });

  it('файл крупнее потолка НА ФАЙЛ назван по имени, а не числом', () => {
    const dir = skillDir('крупный-файл', {
      'SKILL.md': '---\nname: крупный-файл\n---\n',
      'references/маленький.md': 'ок',
      'references/огромный.bin': Buffer.alloc(ATTACHMENT_FILE_LIMIT + 1),
    });

    const read = readSkillAttachments(dir);
    expect(read.attachments.map((file) => file.path)).toEqual(['references/маленький.md']);
    expect(read.skipped).toEqual([
      {
        path: 'references/огромный.bin',
        bytes: ATTACHMENT_FILE_LIMIT + 1,
        reason: 'file_too_large',
      },
    ]);
  });

  it('потолок НА СКИЛЛ выбирает одни и те же файлы при каждом чтении', () => {
    // Шесть файлов по мегабайту: пять влезают в потолок скилла, шестой — нет.
    // Числа настоящие (потолок модуля), потому что проверяется именно он.
    const chunk = 1_000_000;
    const files: Record<string, Buffer | string> = { 'SKILL.md': '---\nname: тяжёлый\n---\n' };
    for (let index = 1; index <= 6; index += 1) {
      files[`references/файл-${index}.bin`] = Buffer.alloc(chunk, index);
    }
    const dir = skillDir('тяжёлый', files);

    const first = readSkillAttachments(dir);
    expect(first.attachments).toHaveLength(5);
    expect(first.attachments.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThanOrEqual(
      ATTACHMENT_SKILL_LIMIT,
    );
    expect(first.skipped).toEqual([
      { path: 'references/файл-6.bin', bytes: chunk, reason: 'skill_too_large' },
    ]);

    // Детерминизм — не придирка: от выбора потолка зависит отпечаток паспорта, и
    // «тот же дом, другой отпечаток» означал бы перенос, которого человек не
    // заказывал.
    const second = readSkillAttachments(dir);
    expect(second.attachments.map((file) => file.path)).toEqual(
      first.attachments.map((file) => file.path),
    );
    expect(second.skipped).toEqual(first.skipped);
  });

  it('ссылка ЗА пределы каталога скилла отвергается, а не увозит чужое дерево', () => {
    const dir = skillDir('со-ссылкой', {
      'SKILL.md': '---\nname: со-ссылкой\n---\n',
      'references/своё.md': 'своё',
    });
    // Соединение каталогов (`junction`) — единственная форма ссылки, которую
    // Windows создаёт без прав администратора; на прочих ОС это обычная ссылка.
    symlinkSync(outside, join(dir, 'чужое'), 'junction');

    const read = readSkillAttachments(dir);
    expect(read.attachments.map((file) => file.path)).toEqual(['references/своё.md']);
    expect(read.skipped).toEqual([{ path: 'чужое', bytes: 0, reason: 'link_outside' }]);
    // Файл из чужого дерева не попал в опись ни одним путём.
    expect(JSON.stringify(read)).not.toContain('чужое.md');
  });
});

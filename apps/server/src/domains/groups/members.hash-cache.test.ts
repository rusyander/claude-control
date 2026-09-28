import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Список групп хэширует каждого участника каждой копии на каждый запрос (F-234):
 * 30 копий × 20 участников — 0,4–1,5 с. Байты каталога читаются заново только
 * при смене отпечатка (пути, размеры, время правки), а формула хэша прежняя —
 * она уже записана в `origin.memberHashes` существующих копий.
 */

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      reads.count += 1;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const { hashDir } = await import('./members.ts');

/** Прежняя формула — независимо от кэша: пути по порядку и байты каждого файла. */
function reference(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(Buffer.from(files[name]!, 'utf8'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

describe('hashDir — отпечаток каталога', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hashdir-'));
    mkdirSync(join(dir, 'references'));
    writeFileSync(join(dir, 'SKILL.md'), 'one');
    writeFileSync(join(dir, 'references', 'a.md'), 'aaa');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('формула хэша прежняя', () => {
    expect(hashDir(dir)).toBe(reference({ 'SKILL.md': 'one', 'references/a.md': 'aaa' }));
  });

  it('каталог не менялся — файлы не читаются второй раз', () => {
    const first = hashDir(dir);
    reads.count = 0;
    expect(hashDir(dir)).toBe(first);
    expect(reads.count).toBe(0);
  });

  it('правка файла (тот же размер) и новый файл меняют хэш', () => {
    const first = hashDir(dir);
    writeFileSync(join(dir, 'references', 'a.md'), 'bbb');
    // Время правки — явно другое: запись в тот же тик часов его бы не сдвинула.
    utimesSync(join(dir, 'references', 'a.md'), new Date(2030, 0, 1), new Date(2030, 0, 1));
    const edited = hashDir(dir);
    expect(edited).not.toBe(first);
    expect(edited).toBe(reference({ 'SKILL.md': 'one', 'references/a.md': 'bbb' }));
    writeFileSync(join(dir, 'references', 'b.md'), 'new');
    expect(hashDir(dir)).toBe(
      reference({ 'SKILL.md': 'one', 'references/a.md': 'bbb', 'references/b.md': 'new' }),
    );
  });
});

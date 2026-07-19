import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupEntry, writeTextFile } from './safe-io.ts';

/**
 * Копии складываются перед каждой записью, а пишет панель часто — каталог
 * копий рос без предела. Внутри лежат в том числе копии файла секретов
 * открытым текстом, так что бесконечное накопление — не только про место.
 *
 * Ротация оставляет последние десять копий КАЖДОГО файла: соседние файлы
 * друг друга не вытесняют.
 */
describe('Ротация резервных копий', () => {
  let dir: string;
  let backupDir: string;
  let source: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rotate-'));
    backupDir = join(dir, 'backups');
    source = join(dir, 'settings.json');
    writeFileSync(source, '{"a":1}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Копии, уже лежащие в каталоге, — с отметками времени по возрастанию. */
  const seedBackups = (base: string, count: number): void => {
    mkdirSync(backupDir, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      const stamp = `2026-07-19T10-00-${String(index).padStart(2, '0')}-000Z`;
      writeFileSync(join(backupDir, `${base}.${stamp}.bak`), `копия ${index}`);
    }
  };

  it('оставляет последние десять копий', () => {
    seedBackups('settings.json', 12);

    backupEntry(source, backupDir);

    const kept = readdirSync(backupDir);
    expect(kept).toHaveLength(10);
  });

  it('удаляет самые старые, а не свежие', () => {
    seedBackups('settings.json', 12);

    backupEntry(source, backupDir);

    const kept = readdirSync(backupDir).sort();
    expect(kept.some((name) => name.includes('10-00-00'))).toBe(false);
    expect(kept.some((name) => name.includes('10-00-11'))).toBe(true);
  });

  it('копии соседних файлов не вытесняют друг друга', () => {
    seedBackups('settings.json', 12);
    seedBackups('CLAUDE.md', 3);

    backupEntry(source, backupDir);

    const kept = readdirSync(backupDir);
    expect(kept.filter((name) => name.startsWith('settings.json.'))).toHaveLength(10);
    expect(kept.filter((name) => name.startsWith('CLAUDE.md.'))).toHaveLength(3);
  });

  it('пока копий меньше предела, ничего не удаляется', () => {
    seedBackups('settings.json', 3);

    backupEntry(source, backupDir);

    expect(readdirSync(backupDir)).toHaveLength(4);
  });

  it('обычная запись через writeTextFile тоже подчищает за собой', () => {
    seedBackups('settings.json', 12);

    writeTextFile(source, '{"a":2}', { backupDir });

    expect(readdirSync(backupDir)).toHaveLength(10);
  });
});

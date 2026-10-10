import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandInstructionText } from './instruction-imports.ts';

/**
 * Регистр в защите от циклов импорта. На Windows `CLAUDE.md` и `claude.md` —
 * один файл, и импорт себя под другим регистром — цикл. На Linux это два файла,
 * и второй раскрывается. Файлы настоящие; платформа подменена: на Windows ФС
 * отдаст `claude.md` содержимым `CLAUDE.md` — для Linux это и есть «другой
 * файл с тем же текстом».
 */
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let dir = '';
let file = '';

const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imports-case-'));
  file = join(dir, 'CLAUDE.md');
  writeFileSync(file, 'тело файла\n', 'utf8');
});

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  rmSync(dir, { recursive: true, force: true });
});

describe('expandInstructionText — регистр пути', () => {
  it('импорт себя в том же написании — цикл на любой системе', () => {
    onPlatform('linux');

    const result = expandInstructionText('@./CLAUDE.md', file);

    expect(result.problems).toEqual([expect.stringContaining('цикл импортов')]);
  });

  it('Windows: импорт себя в другом регистре — тоже цикл', () => {
    onPlatform('win32');

    const result = expandInstructionText('@./claude.md', file);

    expect(result.problems).toEqual([expect.stringContaining('цикл импортов')]);
    expect(result.text).not.toContain('тело файла');
  });

  it('Linux: файл в другом регистре — отдельный файл, раскрывается', () => {
    onPlatform('linux');

    const result = expandInstructionText('@./claude.md', file);

    expect(result.problems).toEqual([]);
    expect(result.text).toContain('тело файла');
  });
});

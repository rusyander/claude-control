import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectClaudeLocation } from './claude-paths.ts';

/**
 * Файл вместо каталога проходил проверку «существует и читается» и ломал
 * переезд уже после смены расположения (`mkdir <файл>/claude-control` → ENOTDIR).
 */
describe('claude-paths: файл вместо каталога', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-paths-file-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ручной путь на файл невалиден и называет причину', () => {
    const file = join(root, 'settings.json');
    writeFileSync(file, '{}');
    const location = detectClaudeLocation(file);
    expect(location.isValid).toBe(false);
    expect(location.problem).toContain('файл, а не каталог');
  });

  it('каталог с тем же содержимым остаётся валидным', () => {
    const location = detectClaudeLocation(root);
    expect(location.isValid).toBe(true);
    expect(location.problem).toBeUndefined();
  });
});

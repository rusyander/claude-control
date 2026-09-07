import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAttachment } from './attachments.ts';
import { ProjectTestsError } from './files.ts';

/**
 * Доказательства к кейсу.
 *
 * Имя файла приходит из браузера, а кладётся на диск — поэтому проверяется, что
 * путь в имени не выводит из папки кейса и что расширение из белого списка.
 */
describe('project-tests/attachments', () => {
  let project = '';
  const now = '2026-09-07T10:11:12.000Z';
  const png = Buffer.from('картинка').toString('base64');

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-attach-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('файл ложится в папку кейса, а путь возвращается от корня проекта', () => {
    const file = saveAttachment(project, 'gui-001', 'shot.png', png, now);

    expect(file.startsWith('.agent/tests/attachments/gui-001/')).toBe(true);
    expect(file.endsWith('shot.png')).toBe(true);
    expect(existsSync(join(project, file))).toBe(true);
    expect(readFileSync(join(project, file), 'utf8')).toBe('картинка');
  });

  it('повторная загрузка не затирает прошлое доказательство', () => {
    const first = saveAttachment(project, 'gui-001', 'shot.png', png, '2026-09-07T10:00:00.000Z');
    const second = saveAttachment(project, 'gui-001', 'shot.png', png, '2026-09-07T11:00:00.000Z');

    expect(second).not.toBe(first);
    expect(existsSync(join(project, first))).toBe(true);
  });

  it('путь в имени файла не выводит из папки кейса', () => {
    const file = saveAttachment(project, 'gui-001', '../../../evil.png', png, now);

    expect(file).toContain('attachments/gui-001/');
    expect(file).not.toContain('..');
  });

  it('исполняемое расширение не принимается', () => {
    expect(() => saveAttachment(project, 'gui-001', 'evil.exe', png, now)).toThrow(
      ProjectTestsError,
    );
  });

  it('пустой файл не принимается', () => {
    expect(() => saveAttachment(project, 'gui-001', 'shot.png', '', now)).toThrow(
      ProjectTestsError,
    );
  });
});

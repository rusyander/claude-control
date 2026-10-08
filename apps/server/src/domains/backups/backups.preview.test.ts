import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFile } from '../../lib/safe-io/safe-io.ts';
import { restorePreview } from './backups.ts';

/**
 * Предпросмотр отката — ревью 28.09. F-12: у копии файла секретов значения с
 * «несекретными» именами (`X_API=…`) шли открытым текстом — в этом файле секрет
 * каждое значение. F-150: ссылка на каталог внутри папки скилла читалась как
 * файл, и предпросмотр падал 500 (EISDIR). Всё во временном каталоге.
 */
describe('backups: предпросмотр отката', () => {
  let dir: string;
  let backupDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-backup-preview-'));
    backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('F-12: в файле секретов скрыто каждое значение, изменение всё равно видно', () => {
    const secretsEnv = join(dir, '.mcp-secrets.env');
    writeFileSync(secretsEnv, 'X_API=abcd1234efgh5678\nPLAIN=value\nSAME=keep-me\n', 'utf8');
    writeTextFile(secretsEnv, 'X_API=zzzz1234efgh5678\nPLAIN=value\nSAME=keep-me\n', {
      backupDir,
    });
    const name = readdirSync(backupDir).find((item) => item.endsWith('.bak'))!;

    const preview = restorePreview(backupDir, name, { secretsEnv });
    expect(preview.ok).toBe(true);
    const file = preview.ok ? preview.files[0]! : undefined;
    const text = `${file?.before}\n${file?.after}`;
    for (const secret of ['abcd1234efgh5678', 'zzzz1234efgh5678', 'value', 'keep-me']) {
      expect(text).not.toContain(secret);
    }
    // Изменившееся значение остаётся изменением, неизменное — нет.
    const line = (body: string | undefined, key: string): string | undefined =>
      body?.split('\n').find((item) => item.startsWith(`${key}=`));
    expect(line(file?.before, 'X_API')).not.toBe(line(file?.after, 'X_API'));
    expect(line(file?.before, 'SAME')).toBe(line(file?.after, 'SAME'));
  });

  it('F-150: ссылка на каталог в папке скилла не роняет предпросмотр', () => {
    const skillsDir = join(dir, 'skills');
    const skill = join(skillsDir, 'review');
    mkdirSync(join(skill, 'assets'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'now\n', 'utf8');
    symlinkSync(join(skill, 'assets'), join(skill, 'linked'), 'junction');
    const name = 'skills-review.2026-01-01T00-00-00-000Z.bak';
    mkdirSync(join(backupDir, name), { recursive: true });
    writeFileSync(join(backupDir, name, 'SKILL.md'), 'then\n', 'utf8');

    const preview = restorePreview(backupDir, name, {}, skillsDir);
    expect(preview.ok).toBe(true);
    expect(preview.ok && preview.files.map((file) => file.path)).toContain('review/SKILL.md');
  });
});

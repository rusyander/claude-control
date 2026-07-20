import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveEnvVar, deleteEnvVar, readEnvVars } from './env.ts';

/**
 * Краевые случаи переменных окружения, вскрытые аудитом: маршрутизация по
 * source и судьба комментариев при удалении. См. .agent/tmp/audit-config.md.
 */
describe('env — краевые случаи', () => {
  let dir: string;
  let settingsPath: string;
  let secretsPath: string;
  let localPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-env-edge-'));
    settingsPath = join(dir, 'settings.json');
    secretsPath = join(dir, '.mcp-secrets.env');
    localPath = join(dir, 'settings.local.json');
    writeFileSync(settingsPath, '{}');
    writeFileSync(secretsPath, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('локальная переменная уходит в settings.local.json, а не в общий конфиг', () => {
    saveEnvVar(
      settingsPath,
      secretsPath,
      { key: 'PERSONAL', value: 'моё', source: 'settings-local', isSecret: false },
      undefined,
      localPath,
    );

    expect(JSON.parse(readFileSync(localPath, 'utf8')).env.PERSONAL).toBe('моё');
    // Общий settings.json не тронут.
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).env).toBeUndefined();
  });

  /**
   * BUG (см. audit → BUG-6). source 'group' — служебный (env групп применяют
   * маршруты групп), но saveEnvVar не отсекает его и через ветку default пишет
   * переменную в .mcp-secrets.env. Тест фиксирует ЖЕЛАЕМОЕ поведение.
   */
  it('source "group" не должен молча писаться в .mcp-secrets.env (BUG-6)', () => {
    saveEnvVar(settingsPath, secretsPath, {
      key: 'GRP',
      value: 'v',
      source: 'group',
      isSecret: false,
    });
    expect(readFileSync(secretsPath, 'utf8')).not.toContain('GRP=');
  });

  it('source "group" не пишет ни в один из штатных файлов (BUG-6)', () => {
    const before = { settings: '{}', secrets: '' };
    saveEnvVar(
      settingsPath,
      secretsPath,
      { key: 'GRP', value: 'v', source: 'group', isSecret: false },
      undefined,
      localPath,
    );

    // Ни secrets, ни settings, ни local не получили переменную группы.
    expect(readFileSync(secretsPath, 'utf8')).toBe(before.secrets);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before.settings);
    expect(existsSync(localPath)).toBe(false);
  });

  /**
   * BUG (см. audit → BUG-7). Удаление секрета убирает строку `KEY=...`, но
   * оставляет висеть комментарий над ней — а он часто описывает, где взять
   * именно этот токен. Тест фиксирует ЖЕЛАЕМОЕ поведение.
   */
  it('удаление секрета уносит и его комментарий (BUG-7)', () => {
    writeFileSync(secretsPath, '# как выпустить токен GitLab\nGITLAB_TOKEN=abc\n');
    deleteEnvVar(settingsPath, secretsPath, 'GITLAB_TOKEN', 'secrets');
    expect(readFileSync(secretsPath, 'utf8')).not.toContain('как выпустить токен');
  });

  it('удаление уносит весь прилегающий блок комментариев, но не соседей (BUG-7)', () => {
    writeFileSync(
      secretsPath,
      [
        '# заголовок файла',
        '',
        '# где выпустить токен',
        '# вторая строка описания',
        'GITLAB_TOKEN=abc',
        'OTHER=keep',
        '',
      ].join('\n'),
    );

    deleteEnvVar(settingsPath, secretsPath, 'GITLAB_TOKEN', 'secrets');
    const after = readFileSync(secretsPath, 'utf8');

    // Прилегающий блок описания токена ушёл вместе с переменной…
    expect(after).not.toContain('где выпустить токен');
    expect(after).not.toContain('вторая строка описания');
    expect(after).not.toContain('GITLAB_TOKEN');
    // …а отделённый пустой строкой заголовок файла и соседняя переменная целы.
    expect(after).toContain('# заголовок файла');
    expect(after).toContain('OTHER=keep');
  });

  it('несколько источников с одинаковым ключом видны как отдельные записи', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { SHARED: 'from-settings' } }));
    writeFileSync(secretsPath, 'SHARED=from-secrets');

    const vars = readEnvVars(settingsPath, secretsPath);
    const ids = vars.filter((v) => v.key === 'SHARED').map((v) => v.id);

    // Разные хранилища — разные id, обе записи показываются.
    expect(ids).toContain('settings:SHARED');
    expect(ids).toContain('secrets:SHARED');
  });
});

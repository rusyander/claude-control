import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@claude-control/contracts';
import {
  readEnvVars,
  revealEnvValue,
  saveEnvVar,
  deleteEnvVar,
  moveEnvVar,
  markGroupEnv,
} from './env.ts';

/**
 * Тесты переменных окружения. Главное здесь — секреты: значение с виду
 * токена не должно утекать в список без явного действия, поэтому маскировка
 * и разделение двух хранилищ (settings.json / .mcp-secrets.env) закреплены
 * тестами. Тест-кейсы см. .agent/TEST-CASES.md → «Переменные окружения».
 *
 * Каждый тест работает с временными файлами и убирает их за собой.
 */
describe('env', () => {
  let dir: string;
  let settingsPath: string;
  let secretsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-env-'));
    settingsPath = join(dir, 'settings.json');
    secretsPath = join(dir, '.mcp-secrets.env');
    writeFileSync(settingsPath, '{}');
    writeFileSync(secretsPath, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('чтение и маскировка', () => {
    it('обычная переменная из settings отдаётся как есть', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { NODE_ENV: 'production' } }));
      const vars = readEnvVars(settingsPath, secretsPath);
      const node = vars.find((v) => v.key === 'NODE_ENV');
      expect(node?.value).toBe('production');
      expect(node?.isSecret).toBe(false);
      expect(node?.source).toBe('settings');
    });

    it('секрет по имени ключа маскируется в списке', () => {
      writeFileSync(secretsPath, 'GITLAB_TOKEN=glpat-1234567890abcdef');
      const vars = readEnvVars(settingsPath, secretsPath);
      const token = vars.find((v) => v.key === 'GITLAB_TOKEN');
      expect(token?.isSecret).toBe(true);
      // Настоящее значение в маскированном не встречается.
      expect(token?.value).not.toContain('1234567890');
      expect(token?.value).toContain('•');
    });

    it('короткий секрет маскируется целиком', () => {
      writeFileSync(secretsPath, 'API_KEY=short');
      const vars = readEnvVars(settingsPath, secretsPath);
      expect(vars.find((v) => v.key === 'API_KEY')?.value).toBe('•••••');
    });

    it('слова TOKEN/SECRET/KEY/PASSWORD/PAT считаются секретом', () => {
      writeFileSync(
        secretsPath,
        ['MY_TOKEN=a', 'DB_PASSWORD=b', 'API_KEY=c', 'X_SECRET=d', 'GH_PAT=e'].join('\n'),
      );
      const vars = readEnvVars(settingsPath, secretsPath);
      expect(vars.every((v) => v.isSecret)).toBe(true);
    });
  });

  describe('комментарии env-файла', () => {
    it('комментарий над переменной привязывается к ней', () => {
      writeFileSync(secretsPath, '# токен для GitLab\nGITLAB_TOKEN=glpat-xxxxxxxxxxxx');
      const vars = readEnvVars(settingsPath, secretsPath);
      expect(vars.find((v) => v.key === 'GITLAB_TOKEN')?.comment).toBe('токен для GitLab');
    });

    it('пустая строка разрывает связь комментария с переменной', () => {
      writeFileSync(secretsPath, '# заголовок файла\n\nPLAIN_VAR=x');
      const vars = readEnvVars(settingsPath, secretsPath);
      expect(vars.find((v) => v.key === 'PLAIN_VAR')?.comment).toBeUndefined();
    });
  });

  describe('раскрытие значения', () => {
    it('revealEnvValue отдаёт полное значение секрета', () => {
      writeFileSync(secretsPath, 'GITLAB_TOKEN=glpat-1234567890abcdef');
      const full = revealEnvValue(settingsPath, secretsPath, 'GITLAB_TOKEN', 'secrets');
      expect(full).toBe('glpat-1234567890abcdef');
    });

    it('revealEnvValue из settings', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { NODE_ENV: 'prod' } }));
      expect(revealEnvValue(settingsPath, secretsPath, 'NODE_ENV', 'settings')).toBe('prod');
    });
  });

  describe('сохранение и удаление', () => {
    it('переменная settings пишется в settings.json', () => {
      saveEnvVar(settingsPath, secretsPath, {
        key: 'NODE_ENV',
        value: 'production',
        source: 'settings',
        isSecret: false,
      });
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.env.NODE_ENV).toBe('production');
    });

    it('секрет пишется в .mcp-secrets.env с комментарием', () => {
      saveEnvVar(settingsPath, secretsPath, {
        key: 'GITLAB_TOKEN',
        value: 'glpat-secret',
        source: 'secrets',
        isSecret: true,
        comment: 'из настроек GitLab',
      });
      const content = readFileSync(secretsPath, 'utf8');
      expect(content).toContain('GITLAB_TOKEN=glpat-secret');
      expect(content).toContain('# из настроек GitLab');
    });

    it('повторное сохранение обновляет строку, не плодит дубли', () => {
      const draft = { key: 'X', value: '1', source: 'secrets' as const, isSecret: false };
      saveEnvVar(settingsPath, secretsPath, draft);
      saveEnvVar(settingsPath, secretsPath, { ...draft, value: '2' });
      const lines = readFileSync(secretsPath, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('X='));
      expect(lines).toEqual(['X=2']);
    });

    it('правка комментария у существующей переменной доходит до файла (#52)', () => {
      const draft = {
        key: 'GITLAB_TOKEN',
        value: 'glpat-1',
        source: 'secrets' as const,
        isSecret: true,
        comment: 'выпустить в GitLab → Settings',
      };
      saveEnvVar(settingsPath, secretsPath, draft);
      saveEnvVar(settingsPath, secretsPath, { ...draft, comment: 'выпустить в git.gorgona.ai' });

      const content = readFileSync(secretsPath, 'utf8');
      // Раньше ветка правки комментарий игнорировала: панель отвечала «сохранено»,
      // а в файле оставался прежний текст.
      expect(content).toContain('# выпустить в git.gorgona.ai');
      expect(content).not.toContain('Settings');
      // И ровно один комментарий, а не два подряд.
      expect(content.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(1);
      expect(
        readEnvVars(settingsPath, secretsPath).find((v) => v.key === 'GITLAB_TOKEN')?.comment,
      ).toBe('выпустить в git.gorgona.ai');
    });

    it('пустой комментарий убирает его из файла, а не оставляет старый (#52)', () => {
      const draft = {
        key: 'API_TOKEN',
        value: '1',
        source: 'secrets' as const,
        isSecret: true,
        comment: 'временный',
      };
      saveEnvVar(settingsPath, secretsPath, draft);
      saveEnvVar(settingsPath, secretsPath, { ...draft, comment: '' });

      const content = readFileSync(secretsPath, 'utf8');
      expect(content).toContain('API_TOKEN=1');
      expect(content).not.toContain('временный');
    });

    it('комментарий не прислали — чужой в файле остаётся (массовое добавление)', () => {
      writeFileSync(secretsPath, '# где выпустить\nAPI_TOKEN=1\n');
      saveEnvVar(settingsPath, secretsPath, {
        key: 'API_TOKEN',
        value: '2',
        source: 'secrets',
        isSecret: true,
      });

      const content = readFileSync(secretsPath, 'utf8');
      expect(content).toContain('# где выпустить');
      expect(content).toContain('API_TOKEN=2');
    });

    it('правка значения не схлопывает многострочный комментарий', () => {
      writeFileSync(secretsPath, '# первая\n# вторая\nAPI_TOKEN=1\n');
      saveEnvVar(settingsPath, secretsPath, {
        key: 'API_TOKEN',
        value: '2',
        source: 'secrets',
        isSecret: true,
        // Форма показывает блок склеенным через пробел и возвращает его как есть.
        comment: 'первая вторая',
      });

      expect(readFileSync(secretsPath, 'utf8')).toBe('# первая\n# вторая\nAPI_TOKEN=2\n');
    });

    it('удаление убирает переменную из своего хранилища', () => {
      saveEnvVar(settingsPath, secretsPath, {
        key: 'GITLAB_TOKEN',
        value: 'x',
        source: 'secrets',
        isSecret: true,
      });
      deleteEnvVar(settingsPath, secretsPath, 'GITLAB_TOKEN', 'secrets');
      expect(readFileSync(secretsPath, 'utf8')).not.toContain('GITLAB_TOKEN');
    });
  });

  describe('moveEnvVar — перенос между settings.json и settings.local.json', () => {
    let localPath: string;

    beforeEach(() => {
      localPath = join(dir, 'settings.local.json');
      writeFileSync(localPath, '{}');
    });

    const env = (path: string): Record<string, string> =>
      JSON.parse(readFileSync(path, 'utf8')).env ?? {};

    it('переносит переменную в локальный файл и обратно, очищая источник', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { NODE_ENV: 'production' } }));

      moveEnvVar(settingsPath, secretsPath, 'NODE_ENV', 'settings', undefined, localPath);
      expect(env(settingsPath)).toEqual({});
      expect(env(localPath).NODE_ENV).toBe('production');

      moveEnvVar(settingsPath, secretsPath, 'NODE_ENV', 'settings-local', undefined, localPath);
      expect(env(localPath)).toEqual({});
      expect(env(settingsPath).NODE_ENV).toBe('production');
    });

    it('переносит реальное значение (в settings.json оно не замаскировано на диске)', () => {
      // Имя секретное, но переменная лежит в settings.json — значение открытое.
      writeFileSync(settingsPath, JSON.stringify({ env: { API_KEY: 'plain-value' } }));

      moveEnvVar(settingsPath, secretsPath, 'API_KEY', 'settings', undefined, localPath);

      expect(env(localPath).API_KEY).toBe('plain-value');
      expect(env(settingsPath)).toEqual({});
    });

    it('секрет из .mcp-secrets.env перенести нельзя — источник не тронут', () => {
      writeFileSync(secretsPath, 'GITLAB_TOKEN=glpat-x');

      expect(() =>
        moveEnvVar(settingsPath, secretsPath, 'GITLAB_TOKEN', 'secrets', undefined, localPath),
      ).toThrow();
      expect(readFileSync(secretsPath, 'utf8')).toContain('GITLAB_TOKEN=glpat-x');
    });
  });

  // Аудит «Группы» 2026-09-03: контракт держал source `group`, но список отдавал
  // ключи групп как обычные settings — и страница давала их править и удалять.
  describe('переменные групп', () => {
    const group = (over: Partial<Group>): Group => ({
      id: 'g',
      name: 'g',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      isEnabled: true,
      order: 0,
      ...over,
    });

    it('ключ включённой группы получает source group и groupId; остальные не тронуты', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { FROM_GROUP: '1', MINE: '2' } }));
      const vars = markGroupEnv(readEnvVars(settingsPath, secretsPath), [
        group({ id: 'g1', env: { FROM_GROUP: '1' } }),
      ]);
      expect(vars.find((v) => v.key === 'FROM_GROUP')).toMatchObject({
        id: 'group:FROM_GROUP',
        source: 'group',
        groupId: 'g1',
      });
      expect(vars.find((v) => v.key === 'MINE')).toMatchObject({ source: 'settings' });
      expect(vars.find((v) => v.key === 'MINE')?.groupId).toBeUndefined();
    });

    it('выключенная группа не хозяин: её ключ в файле — пользовательский', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { FROM_GROUP: '1' } }));
      const vars = markGroupEnv(readEnvVars(settingsPath, secretsPath), [
        group({ id: 'g1', env: { FROM_GROUP: '1' }, isEnabled: false }),
      ]);
      expect(vars[0]).toMatchObject({ source: 'settings' });
    });

    it('локальный файл и секреты группе не приписываются; из двух групп хозяин — первая по порядку', () => {
      const localPath = join(dir, 'settings.local.json');
      writeFileSync(settingsPath, JSON.stringify({ env: { SHARED: 'a' } }));
      writeFileSync(localPath, JSON.stringify({ env: { SHARED: 'b' } }));
      writeFileSync(secretsPath, 'SHARED=c\n');
      const vars = markGroupEnv(readEnvVars(settingsPath, secretsPath, localPath), [
        group({ id: 'later', env: { SHARED: 'a' }, order: 5 }),
        group({ id: 'first', env: { SHARED: 'a' }, order: 1 }),
      ]);
      expect(vars.map((v) => [v.source, v.groupId])).toEqual([
        ['group', 'first'],
        ['settings-local', undefined],
        ['secrets', undefined],
      ]);
    });

    it('показ значения по source group читает settings.json', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { GROUP_TOKEN: 'secret-value-1' } }));
      expect(revealEnvValue(settingsPath, secretsPath, 'GROUP_TOKEN', 'group')).toBe(
        'secret-value-1',
      );
      expect(() => revealEnvValue(settingsPath, secretsPath, 'NOPE', 'group')).toThrow();
    });
  });
});

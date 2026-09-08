import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectTestsError } from './files.ts';
import { declareSecret, readEnvironments, saveEnvironment } from './library.ts';
import { setStoredKey } from '../../lib/provider-keys.ts';
import {
  describeSecrets,
  environmentSecretsKey,
  forgetEnvironmentSecrets,
  readSecretValues,
  redactor,
  runSecrets,
  writeSecretValue,
} from './env-secrets.ts';

/**
 * Доступы стенда.
 *
 * Главная проверка здесь одна и та же с разных сторон: секрет не должен
 * оказаться ни в файле проекта (он в git), ни в том, что панель отдаёт наружу.
 * Всё остальное — следствия: нехватка не отменяет прогон, удаление окружения
 * уносит и пароль, а имена панели заняты собой.
 */
describe('project-tests/env-secrets', () => {
  let project = '';
  let appData = '';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-secret-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-tests-appdata-'));
  });

  afterEach(() => {
    for (const dir of [project, appData]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const environment = () => saveEnvironment(project, { title: 'Стенд', isDefault: true });

  it('в файле проекта остаётся имя переменной, а значения там нет вовсе', () => {
    const env = environment();
    declareSecret(project, env.id, { name: 'STAND_PASSWORD', title: 'Пароль тестового входа' });
    writeSecretValue(appData, project, env.id, 'STAND_PASSWORD', 'очень-секретно-42');

    const file = readFileSync(join(project, '.agent', 'tests', 'environments.json'), 'utf8');
    expect(file).toContain('STAND_PASSWORD');
    expect(file).not.toContain('очень-секретно-42');
    expect(readEnvironments(project)[0]?.secrets).toEqual([
      { name: 'STAND_PASSWORD', title: 'Пароль тестового входа' },
    ]);
  });

  it('на диске панели секрет лежит зашифрованным — открытым текстом его там нет', () => {
    const env = environment();
    writeSecretValue(appData, project, env.id, 'STAND_TOKEN', 'открытый-токен-стенда');

    const onDisk = readdirSync(appData)
      .map((name) => readFileSync(join(appData, name)).toString('binary'))
      .join('\n');
    expect(onDisk).not.toContain('открытый-токен-стенда');
    expect(readSecretValues(appData, project, env.id)).toEqual({
      STAND_TOKEN: 'открытый-токен-стенда',
    });
  });

  it('наружу уходит только маска и признак «задан»', () => {
    const env = environment();
    declareSecret(project, env.id, { name: 'STAND_PASSWORD' });
    declareSecret(project, env.id, { name: 'STAND_LOGIN' });
    writeSecretValue(appData, project, env.id, 'STAND_PASSWORD', 'очень-секретно-42');

    const shown = describeSecrets(appData, project, readEnvironments(project)[0]!);
    const password = shown.find((item) => item.name === 'STAND_PASSWORD');
    const login = shown.find((item) => item.name === 'STAND_LOGIN');

    expect(password?.hasValue).toBe(true);
    // Маска — это «задан», а не подсказка: видно длину и два последних символа.
    expect(password?.masked).toMatch(/^•+42$/);
    expect(password?.masked).not.toContain('очень');
    expect(JSON.stringify(shown)).not.toContain('очень-секретно-42');
    expect(login).toMatchObject({ hasValue: false, masked: '' });
  });

  it('значение без объявления показывается: иначе секрет висел бы незамеченным', () => {
    const env = environment();
    // Имя убрали из файла проекта (правкой руками или чужим коммитом), а
    // значение осталось в панели — молчать о нём нельзя.
    writeSecretValue(appData, project, env.id, 'STAND_OLD', 'забытое-значение');

    const shown = describeSecrets(appData, project, readEnvironments(project)[0]!);
    expect(shown.find((item) => item.name === 'STAND_OLD')?.hasValue).toBe(true);
  });

  it('нехватка значения прогон не отменяет, а называет переменную', () => {
    const env = environment();
    declareSecret(project, env.id, { name: 'STAND_PASSWORD', title: 'Пароль' });
    declareSecret(project, env.id, { name: 'STAND_LOGIN' });
    writeSecretValue(appData, project, env.id, 'STAND_LOGIN', 'qa-user');

    const forRun = runSecrets(appData, project, readEnvironments(project)[0]!);
    expect(forRun.values).toEqual({ STAND_LOGIN: 'qa-user' });
    expect(forRun.missing).toEqual([{ name: 'STAND_PASSWORD', title: 'Пароль' }]);
  });

  it('окружения нет — прогон идёт без доступов, а не падает', () => {
    expect(runSecrets(appData, project, undefined)).toEqual({ values: {}, missing: [] });
  });

  it('удаление окружения уносит и его секреты', () => {
    const env = environment();
    writeSecretValue(appData, project, env.id, 'STAND_TOKEN', 'токен-стенда-1');
    forgetEnvironmentSecrets(appData, project, env.id);

    expect(readSecretValues(appData, project, env.id)).toEqual({});
  });

  it('пустое значение стирает сохранённое', () => {
    const env = environment();
    writeSecretValue(appData, project, env.id, 'STAND_TOKEN', 'токен-стенда-1');
    writeSecretValue(appData, project, env.id, 'STAND_TOKEN', '');

    expect(readSecretValues(appData, project, env.id)).toEqual({});
  });

  it('переменные самой панели под доступы стенда не отдаются', () => {
    const env = environment();
    for (const name of ['PATH', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) {
      expect(() => declareSecret(project, env.id, { name })).toThrow(ProjectTestsError);
    }
  });

  it('негодное имя переменной отвергается с причиной', () => {
    const env = environment();
    expect(() => declareSecret(project, env.id, { name: '2-пароль' })).toThrow(
      /не годится именем переменной/,
    );
  });

  it('доступы соседнего проекта не видны: путь входит в ключ', () => {
    const env = environment();
    writeSecretValue(appData, project, env.id, 'STAND_TOKEN', 'токен-первого');
    const other = mkdtempSync(join(tmpdir(), 'cc-tests-other-'));
    try {
      expect(readSecretValues(appData, other, env.id)).toEqual({});
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('секрет из вывода агента затирается, а остальной текст цел', () => {
    const hide = redactor({ STAND_PASSWORD: 'очень-секретно-42', STAND_LOGIN: 'qa' })!;

    const text = hide('вход: curl -u qa:очень-секретно-42 https://stand.example');
    expect(text).not.toContain('очень-секретно-42');
    expect(text).toContain('https://stand.example');
    // Короткое значение — не секрет: затирать его значило бы испортить лог.
    expect(text).toContain('qa');
  });

  it('без доступов затирания нет вовсе — лишней работы на каждой строке лога', () => {
    expect(redactor({})).toBeUndefined();
  });

  it('битая запись хранилища читается как пустая, а не роняет прогон', () => {
    const env = environment();
    // Хранилище общее с ключами провайдеров: там значение — просто строка, и
    // «не JSON» в нашей ячейке возможен так же, как чужой формат после отката.
    setStoredKey(appData, environmentSecretsKey(project, env.id), 'не json');

    expect(readSecretValues(appData, project, env.id)).toEqual({});
  });
});

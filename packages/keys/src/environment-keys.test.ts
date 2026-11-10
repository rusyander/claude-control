import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_KEY_PREFIX, environmentSecretsKey } from './environment-keys.ts';

/**
 * Ключ доступов стенда — один на панель и ядро (этап 12): запись «Тестов» и вход прохода по
 * стенду ищут одну и ту же строку хранилища. Путь Windows складывается без регистра, POSIX — с ним.
 */
describe('environment secrets key', () => {
  it('env: prefix, normalised root, environment id', () => {
    expect(ENVIRONMENT_KEY_PREFIX).toBe('env:');
    expect(environmentSecretsKey('/srv/app', 'dev')).toBe('env:/srv/app:dev');
  });

  it('a Windows root folds slashes, the trailing slash and case to one key', () => {
    const key = environmentSecretsKey('C:\\Repos\\App\\', 'stage');
    expect(key).toBe('env:c:/repos/app:stage');
    expect(environmentSecretsKey('c:/repos/app', 'stage')).toBe(key);
    expect(environmentSecretsKey('\\\\HOST\\Share\\App', 'e')).toBe('env://host/share/app:e');
  });

  it('a POSIX root keeps its case: two folders, two keys', () => {
    expect(environmentSecretsKey('/srv/App/', 'e')).toBe('env:/srv/App:e');
    expect(environmentSecretsKey('/srv/app', 'e')).not.toBe(environmentSecretsKey('/srv/App', 'e'));
  });
});

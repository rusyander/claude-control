import { describe, expect, it } from 'vitest';
import { withoutUserinfo } from './watched.ts';

/**
 * Адрес пуша в опросе форжа — без учётных данных (ревью F9): ключ файла отметок, строки журнала
 * ядра и цель события строятся из него, токен из `https://user:token@…` туда не попадает.
 */

describe('withoutUserinfo', () => {
  it.each([
    [
      'https://oauth2:glpat-xyz@gitlab.example.test/acme/app.git',
      'https://gitlab.example.test/acme/app.git',
    ],
    ['https://x-access-token:ghs_1@github.com/acme/app.git', 'https://github.com/acme/app.git'],
    [
      'https://token@gitlab.example.test:8443/acme/app.git',
      'https://gitlab.example.test:8443/acme/app.git',
    ],
    ['ssh://git@gitlab.example.test/acme/app.git', 'ssh://gitlab.example.test/acme/app.git'],
  ])('strips the userinfo of %s', (raw, clean) => {
    expect(withoutUserinfo(raw)).toBe(clean);
  });

  it.each([
    'https://gitlab.example.test/acme/app.git',
    'git@gitlab.example.test:acme/app.git',
    '/srv/git/app.git',
    'C:\\repos\\app.git',
  ])('leaves %s as it is', (url) => {
    expect(withoutUserinfo(url)).toBe(url);
  });
});

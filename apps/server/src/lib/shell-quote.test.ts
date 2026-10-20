import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote } from './shell-quote.ts';

/** Строка доходит до настоящего `/bin/sh` — аргумент должен прийти байт в байт. */
describe('shellQuote', () => {
  const awkward = [
    '/home/u/plain/x',
    '/home/u/a$b/pkg',
    '/home/u/a;b/pkg',
    '/home/u/My $HOME x/pkg',
    '/home/u/a`id`/pkg',
    "/home/u/it's/pkg",
    '/home/u/(1) *?/pkg',
    '',
  ];

  it.skipIf(process.platform === 'win32')('POSIX: sh получает путь как есть', () => {
    for (const value of awkward) {
      const line = `node -e "console.log(JSON.stringify(process.argv[1]))" ${shellQuote(value, 'linux')}`;
      const out = spawnSync(line, { shell: true, encoding: 'utf8' }).stdout.trim();
      expect(JSON.parse(out), value).toBe(value);
    }
  });

  it('Windows: прежние двойные кавычки только при пробеле или знаке cmd', () => {
    expect(shellQuote('C:\\work\\repo\\.venv\\Scripts\\python.exe', 'win32')).toBe(
      'C:\\work\\repo\\.venv\\Scripts\\python.exe',
    );
    expect(shellQuote('C:\\My Repo\\x (1)', 'win32')).toBe('"C:\\My Repo\\x (1)"');
  });

  it('POSIX: простой путь без кавычек, остальное — в одинарных', () => {
    expect(shellQuote('/home/u/repo/.venv/bin/python', 'linux')).toBe(
      '/home/u/repo/.venv/bin/python',
    );
    expect(shellQuote("/home/u/it's", 'darwin')).toBe(`'/home/u/it'\\''s'`);
  });
});

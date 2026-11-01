import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lsRemote, parseLsRemote } from './ls-remote.ts';

/**
 * Ссылки удалённого (класс `git.ls-remote`) — на настоящем голом репозитории во временном каталоге:
 * «нет ветки» и «не смог прочитать» обязаны расходиться (P44).
 */

let root: string;
let bare: string;
let clone: string;
let head: string;
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-ls-remote-'));
  bare = join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  clone = join(root, 'clone');
  g(root, 'clone', '-q', bare, clone);
  g(clone, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(clone, 'a.txt'), 'one');
  g(clone, 'add', '-A');
  g(clone, 'commit', '-q', '-m', 'a');
  g(clone, 'push', '-q', 'origin', 'main');
  head = g(clone, 'rev-parse', 'HEAD');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('ls-remote fact', () => {
  it('lists the server refs by remote name: main points at the pushed commit', async () => {
    const fact = await lsRemote(clone, 'origin');
    expect(fact).toEqual({ value: expect.objectContaining({ 'refs/heads/main': head }) });
  });

  it('a named ref the server does not have is absent, not an empty value', async () => {
    expect(await lsRemote(clone, 'origin', ['refs/heads/nope'])).toEqual({ absent: true });
  });

  it('a named ref the server has comes back alone', async () => {
    expect(await lsRemote(clone, bare, ['refs/heads/main'])).toEqual({
      value: { 'refs/heads/main': head },
    });
  });

  it('an unreachable remote is unknown with the reason, never absent', async () => {
    const fact = await lsRemote(clone, join(root, 'missing.git'), ['refs/heads/main']);
    expect(fact).toEqual({ unknown: expect.stringContaining('git ls-remote') });
  });

  it('parses tab- and space-separated lines, skips blanks and CRLF', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(64);
    expect(parseLsRemote(`${a}\trefs/heads/x\r\n\n${b} refs/tags/v1\n`)).toEqual({
      'refs/heads/x': a,
      'refs/tags/v1': b,
    });
  });

  it('garbage instead of a listing is unknown, never «ref absent»', async () => {
    expect(() => parseLsRemote('<html>proxy login</html>\n')).toThrow(/unexpected line/);
    const fact = await lsRemote(clone, 'origin', ['refs/heads/nope'], {
      run: async () => ({
        ok: true,
        code: 0,
        stdout: 'Welcome to the proxy\n',
        stderr: '',
        timedOut: false,
      }),
    });
    expect(fact).toEqual({ unknown: expect.stringContaining('unexpected line') });
  });
});

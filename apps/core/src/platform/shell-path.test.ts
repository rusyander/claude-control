import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSentinelEnv, readLoginShellPath } from './shell-path.ts';
import { pidExists, waitFor } from './__fixtures__/harness.ts';

const isWin = process.platform === 'win32';
let dir = '';

/**
 * Поддельная оболочка: ведёт себя как rc пользователя (`body`), потом исполняет то, что ей
 * передали после `-lic`, настоящим /bin/sh — с PATH, который «собрал» rc.
 */
function fakeShell(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\n${body}\nPATH=/opt/rc-built/bin:/usr/bin:/bin\nexport PATH\nexec /bin/sh -c "$2"\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-path-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('P104 login-shell PATH — sentinel parser', () => {
  it('P104 env between salted markers is read; banner before and garbage after ignored; fake early marker loses', () => {
    const begin = '__B_x1__';
    const end = '__E_x1__';
    const out = `Welcome!\n${begin}\nfake\0\n${begin}\nPATH=/a:/b\0HOME=/h\0MULTI=1\n2\0\n${end}\nlogout\n`;
    const env = parseSentinelEnv(out, begin, end);
    expect(env?.get('PATH')).toBe('/a:/b');
    expect(env?.get('MULTI')).toBe('1\n2');
    expect(env?.has('fake')).toBe(false);
    expect(parseSentinelEnv('no markers', begin, end)).toBeUndefined();
    expect(parseSentinelEnv(`${begin}\nPATH=/x\0`, begin, end)).toBeUndefined();
  });

  it.runIf(isWin)('P104 Windows → not applicable, current PATH kept, reason named', async () => {
    const got = await readLoginShellPath({ env: { PATH: 'C:\\a;C:\\b' }, os: 'win32' });
    expect(got).toEqual({
      path: 'C:\\a;C:\\b',
      source: 'not-applicable',
      reason: 'Windows: PATH is not built by a login shell',
    });
  });
});

describe.runIf(!isWin)('P104 login-shell PATH — fake shells on this OS', () => {
  const base = { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, knownDirs: ['/known/bin'] };

  it('P104 rc that prints a banner → PATH from the shell, banner ignored', async () => {
    const shell = fakeShell('banner.sh', 'echo "Welcome to the rc"; echo "PATH=/evil"');
    const got = await readLoginShellPath({ ...base, shell });
    expect(got).toEqual({ path: '/opt/rc-built/bin:/usr/bin:/bin', source: 'login-shell' });
  });

  it('P104 rc that prompts (read) → stdin is /dev/null, no hang, PATH read', async () => {
    const shell = fakeShell('prompt.sh', 'printf "Passphrase: "; read answer');
    const started = Date.now();
    const got = await readLoginShellPath({ ...base, shell, timeoutMs: 5_000 });
    expect(got.source).toBe('login-shell');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('P104 rc that hangs → timeout, known dirs, reason named, rc children killed', async () => {
    const pidFile = join(dir, 'hang.pid');
    const shell = fakeShell('hang.sh', `sleep 60 & echo $! > '${pidFile}'; wait`);
    const got = await readLoginShellPath({ ...base, shell, timeoutMs: 800 });
    expect(got).toEqual({
      path: '/usr/bin:/bin:/known/bin',
      source: 'known-dirs',
      reason: 'login shell timed out after 800 ms',
    });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await waitFor(() => (pidExists(pid) ? undefined : true), 5_000, 'rc child gone')).toBe(
      true,
    );
  });

  it('P104 shell that exits without markers → known dirs, reason names the exit', async () => {
    const shell = join(dir, 'broken.sh');
    writeFileSync(shell, '#!/bin/sh\necho "rc error"; exit 3\n');
    chmodSync(shell, 0o755);
    const got = await readLoginShellPath({ ...base, shell });
    expect(got.source).toBe('known-dirs');
    expect(got.reason).toBe('no sentinel in login shell output (exit 3)');
  });

  it('P104 shell missing → known dirs, reason named', async () => {
    const got = await readLoginShellPath({ ...base, shell: join(dir, 'nope') });
    expect(got.source).toBe('known-dirs');
    expect(got.reason).toMatch(/^shell did not start/);
  });

  it.runIf(existsSync('/bin/bash'))(
    'P104 real /bin/bash -lic → PATH read from the login shell',
    async () => {
      const got = await readLoginShellPath({
        shell: '/bin/bash',
        env: { PATH: '/usr/bin:/bin', HOME: dir },
      });
      expect(got.source).toBe('login-shell');
      expect(got.path).toContain('/usr/bin');
    },
  );
});

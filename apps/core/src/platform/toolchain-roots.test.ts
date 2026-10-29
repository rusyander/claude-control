import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { currentOs } from './os-kind.ts';
import { toolchainReadRoots } from './toolchain-roots.ts';

/**
 * Кеши и инструменты в области чтения сеанса (F-87): из переменных инструментов и умолчаний ОС,
 * без путей пользователя; дом и каталоги с токенами (`~/.cargo` целиком) в список не входят.
 */

const located =
  (map: Record<string, string>) =>
  (command: string): string | undefined =>
    map[command];

describe('F-87 toolchainReadRoots', () => {
  it('linux defaults: caches, stores and the running toolchains, never the home itself', () => {
    const roots = toolchainReadRoots({
      env: { HOME: '/home/u' },
      os: 'linux',
      execPath: '/opt/node/bin/node',
      locate: located({ python3: '/usr/bin/python3.12' }),
    });
    expect(roots).toEqual(
      expect.arrayContaining([
        '/home/u/.cache',
        '/home/u/.npm',
        '/home/u/.local/share/pnpm/store',
        '/home/u/.cache/pip',
        '/home/u/go/pkg/mod',
        '/home/u/.cargo/registry',
        '/home/u/.cargo/git',
        '/home/u/.rustup/toolchains',
        '/opt/node/lib/node_modules',
        '/opt/node/include/node',
        '/usr/lib/python3.12',
        '/usr/lib/python3/dist-packages',
        '/home/u/.local/lib/python3.12',
      ]),
    );
    for (const wide of ['/home/u', '/home/u/.cargo', '/usr', '/usr/lib', '/opt/node', '/']) {
      expect(roots).not.toContain(wide);
    }
  });

  it('linux: the tool variables win over the defaults; relative values are dropped', () => {
    const roots = toolchainReadRoots({
      env: {
        HOME: '/home/u',
        XDG_CACHE_HOME: '/c',
        npm_config_cache: '/npm-c',
        npm_config_prefix: '/npm-p',
        npm_config_store_dir: '/pnpm-s',
        PNPM_HOME: '/pnpm-h',
        PIP_CACHE_DIR: 'relative/pip',
        GOPATH: ':/g1:/g2',
        CARGO_HOME: '/cargo',
        RUSTUP_HOME: '/rustup',
      },
      os: 'linux',
      execPath: '/opt/node/bin/node',
      copyRoot: '/work/copy',
      locate: located({ python3: '/usr/bin/python3' }),
    });
    expect(roots).toEqual(
      expect.arrayContaining([
        '/c',
        '/npm-c',
        '/npm-p/lib/node_modules',
        '/pnpm-s',
        '/pnpm-h',
        '/.pnpm-store',
        '/g1/pkg/mod',
        '/cargo/registry',
        '/cargo/git',
        '/rustup/toolchains',
      ]),
    );
    expect(roots).not.toContain('relative/pip');
    expect(roots).not.toContain('/home/u/.npm');
    // Неверсионное имя интерпретатора: `<prefix>/lib` слишком широк — ничего.
    expect(roots.some((r) => r.startsWith('/usr/lib'))).toBe(false);
  });

  it('darwin defaults live under Library', () => {
    const roots = toolchainReadRoots({
      env: { HOME: '/Users/u' },
      os: 'darwin',
      execPath: '/opt/homebrew/bin/node',
      locate: located({}),
    });
    expect(roots).toEqual(
      expect.arrayContaining(['/Users/u/Library/pnpm/store', '/Users/u/Library/Caches/pip']),
    );
  });

  it('win32: AppData stores, node install dir, a real Python install; the Store stub is not one', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\u',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      Npm_Config_Cache: 'D:\\npm-cache',
    };
    const roots = toolchainReadRoots({
      env,
      os: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      copyRoot: 'E:\\work\\copy',
      locate: located({ python: 'C:\\Python312\\python.exe' }),
    });
    expect(roots).toEqual(
      expect.arrayContaining([
        'C:\\Users\\u\\.cache',
        'D:\\npm-cache',
        'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules',
        'C:\\Users\\u\\AppData\\Local\\pnpm\\store',
        'E:\\.pnpm-store',
        'C:\\Users\\u\\AppData\\Local\\pip\\Cache',
        'C:\\Program Files\\nodejs',
        'C:\\Python312',
      ]),
    );
    expect(roots).not.toContain('C:\\Users\\u');
    expect(roots).not.toContain('C:\\Users\\u\\AppData\\Local');
    const stub = toolchainReadRoots({
      env,
      os: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      locate: located({
        python: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
      }),
    });
    expect(stub.some((r) => r.toLowerCase().endsWith('windowsapps'))).toBe(false);
  });

  it('the go root is taken from the go program only when it is a Go distribution (VERSION beside bin)', () => {
    const base = tempDir('toolchain-go-');
    const real = join(base, 'go-real');
    const fake = join(base, 'go-fake');
    mkdirSync(join(real, 'bin'), { recursive: true });
    mkdirSync(join(fake, 'bin'), { recursive: true });
    writeFileSync(join(real, 'VERSION'), 'go1.23');
    const env = currentOs() === 'win32' ? { USERPROFILE: base } : { HOME: base };
    const withReal = toolchainReadRoots({ env, locate: located({ go: join(real, 'bin', 'go') }) });
    const withFake = toolchainReadRoots({ env, locate: located({ go: join(fake, 'bin', 'go') }) });
    expect(withReal).toContain(real);
    expect(withFake).not.toContain(fake);
  });
});

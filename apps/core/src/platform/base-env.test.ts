import { describe, expect, it } from 'vitest';
import { readBaseEnv } from './base-env.ts';

/**
 * Базовое окружение раннеров и установщиков (A2r5-F07, B2r6-F05): переменные, по которым
 * testcontainers и CLI находят движок (Colima, Podman, rootless), доходят до прогона; `TMPDIR` —
 * наравне с `TEMP`/`TMP`; PATH берётся из переданного окружения, а не из окружения ядра;
 * прочее окружение ядра (секреты, токены) не передаётся.
 */

const source: NodeJS.ProcessEnv = {
  HOME: '/home/u',
  PATH: '/task/bin',
  DOCKER_HOST: 'unix:///home/u/.colima/default/docker.sock',
  DOCKER_CONTEXT: 'colima',
  XDG_RUNTIME_DIR: '/run/user/1000',
  TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: '/var/run/docker.sock',
  TESTCONTAINERS_RYUK_DISABLED: 'true',
  TMPDIR: '/tmp/u',
  TEMP: 'C:\\t',
  GITHUB_TOKEN: 'secret',
};

describe('readBaseEnv', () => {
  it('passes engine-locating variables always and TMPDIR only with temp; never unrelated secrets', async () => {
    const runner = await readBaseEnv({ temp: false, env: source, os: 'win32' });
    expect(Object.keys(runner).sort()).toEqual(
      [
        'DOCKER_CONTEXT',
        'DOCKER_HOST',
        'HOME',
        'PATH',
        'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE',
        'TESTCONTAINERS_RYUK_DISABLED',
        'XDG_RUNTIME_DIR',
      ].sort(),
    );
    const installer = await readBaseEnv({ temp: true, env: source, os: 'win32' });
    expect(installer.TMPDIR).toBe('/tmp/u');
    expect(installer.TEMP).toBe('C:\\t');
    expect(installer.GITHUB_TOKEN).toBeUndefined();
  });

  it('PATH comes from the passed env, not from the core process', async () => {
    const got = await readBaseEnv({ temp: false, env: source, os: 'win32' });
    expect(got.PATH).toBe('/task/bin');
  });

  it('the engine the probe actually used wins over the user variables', async () => {
    const got = await readBaseEnv({
      temp: false,
      env: source,
      os: 'win32',
      engine: { DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' },
    });
    expect(got.DOCKER_HOST).toBe('unix:///run/user/1000/podman/podman.sock');
  });
});

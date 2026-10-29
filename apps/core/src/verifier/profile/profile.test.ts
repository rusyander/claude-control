import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RepoViewIo } from '../../platform/repo-view.types.ts';
import { realRepoViewIo } from '../../platform/repo-view.ts';
import { profileMoved, profileOf, profilePath, registryOf, type ProfileDeps } from './index.ts';
import { REPOS, type RepoFiles } from './__fixtures__/repos.ts';

/**
 * `profileOf`/`registryOf` на настоящем каталоге (04:45-52, 04:102-103, P44): профиль хранится в
 * доме ядра, повторяется, пока входы не сдвинулись, и обнаруживается заново, когда сдвинулись.
 * Любой сбой чтения — `unknown`, никогда пустой или угаданный реестр; нечитаемый сохранённый
 * профиль не затирается.
 */

const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-core-profile-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function repo(files: RepoFiles): { path: string; repoKey: string } {
  const path = join(scratch, `repo-${++n}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, rel)), { recursive: true });
    writeFileSync(join(path, rel), text);
  }
  return { path, repoKey: `key-${n}` };
}

function deps(extra: Partial<ProfileDeps> = {}): ProfileDeps {
  return { profilesDir: join(scratch, 'home', 'profiles'), os: 'linux', now: () => 1000, ...extra };
}

/** Таймер, который срабатывает сразу: проба тайм-аута без ожидания настоящих 10 секунд. */
const fireNow = (fn: () => void) => {
  queueMicrotask(fn);
  return { cancel: () => undefined };
};

const never = (): Promise<never> => new Promise(() => undefined);

function faultyIo(fault: 'enoent-mid' | 'eperm' | 'garbage' | 'hang'): RepoViewIo {
  return {
    rootExists: realRepoViewIo.rootExists,
    readdir: async (p) => {
      if (fault === 'hang') return never();
      if (fault === 'garbage') return [{ name: 42 }] as never;
      const e = Object.assign(new Error(`${fault}: ${p}`), {
        code: fault === 'eperm' ? 'EPERM' : 'ENOENT',
      });
      throw e;
    },
    readFile: realRepoViewIo.readFile,
  };
}

describe('profileOf / registryOf', () => {
  it('stores the profile in the core home, reuses it while inputs hold, re-detects when they move', async () => {
    const r = repo(REPOS.go as RepoFiles);
    const first = await profileOf(r, deps());
    expect('value' in first && first.value.stacks).toEqual([{ stack: 'go', root: '' }]);
    const stored = profilePath(deps().profilesDir, r.repoKey);
    const onDisk = JSON.parse(readFileSync(stored, 'utf8'));
    expect(onDisk.inputsFp).toBe('value' in first ? first.value.inputsFp : '');

    // Правка человека в сохранённом профиле живёт, пока входы не сдвинулись, и переносится после.
    onDisk.userEdits = { note: 'mine' };
    writeFileSync(stored, JSON.stringify(onDisk));
    const again = await profileOf(r, deps({ now: () => 2000 }));
    expect('value' in again && again.value.detectedAt).toBe(1000);

    writeFileSync(join(r.path, 'pyproject.toml'), '[project]\nname = "x"\n');
    const moved = await profileMoved({ inputsFp: onDisk.inputsFp }, r, deps({ now: () => 3000 }));
    expect('value' in moved && moved.value.moved).toBe(true);
    if (!('value' in moved)) return;
    expect(moved.value.profile.stacks.map((s) => s.stack)).toEqual(['go', 'python']);
    expect(moved.value.profile.userEdits).toEqual({ note: 'mine' });
    expect(moved.value.profile.detectedAt).toBe(3000);
  });

  it('a missing repo folder is absent; registryOf passes the registry through check.registry', async () => {
    expect(await profileOf({ path: join(scratch, 'nope'), repoKey: 'k' }, deps())).toEqual({
      absent: true,
    });
    const r = repo(REPOS.rust as RepoFiles);
    const reg = await registryOf(r, deps());
    expect('value' in reg && reg.value.checks.map((c) => c.id)).toEqual([
      'rust:fmt',
      'rust:clippy',
      'rust:test',
    ]);
  });

  it('a fault mid-walk is unknown, never a partial profile: ENOENT, EPERM, garbage, timeout', async () => {
    const r = repo(REPOS.go as RepoFiles);
    for (const fault of ['enoent-mid', 'eperm', 'garbage'] as const) {
      const p = await profileOf(r, deps({ viewIo: faultyIo(fault) }));
      expect('unknown' in p, fault).toBe(true);
      const reg = await registryOf(r, deps({ viewIo: faultyIo(fault) }));
      expect('unknown' in reg, fault).toBe(true);
    }
    const hung = await profileOf(
      r,
      deps({ viewIo: faultyIo('hang'), viewOptions: { setTimer: fireNow } }),
    );
    expect(hung).toEqual({ unknown: 'timeout after 10000 ms' });
  });

  it('an unreadable stored profile is not overwritten and the fresh profile names it', async () => {
    const r = repo(REPOS.go as RepoFiles);
    const stored = profilePath(deps().profilesDir, r.repoKey);
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(stored, '{"v":1,"half":');
    const p = await profileOf(r, deps());
    expect('value' in p && p.value.notes.at(-1)?.why).toMatch(/stored profile unreadable/);
    expect(readFileSync(stored, 'utf8')).toBe('{"v":1,"half":');
    const reader = await profileOf(r, deps({ readStored: async () => ({ unknown: 'EIO: disk' }) }));
    expect('value' in reader && reader.value.notes.at(-1)?.why).toMatch(/EIO: disk/);
  });
});

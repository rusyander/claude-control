import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkServices } from './check-services.ts';

/**
 * Сервисы проверки на пути очереди (04:93, 04:124): профиль копии непрочитан — причина, не
 * «готово» (корни стеков не узнать — `.env` стека остался бы с адресом настоящей базы); профиль
 * копии читается без записи — общий `profiles/<repoKey>.json` держит основную копию, не копию
 * посреди задачи (04:102).
 */

const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-check-services-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repoWithCopy(name: string): { main: string; copy: string; profiles: string } {
  const main = join(scratch, name, 'main');
  const copy = join(scratch, name, 'copy');
  const profiles = join(scratch, name, 'profiles');
  mkdirSync(join(main, 'api'), { recursive: true });
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(main, 'package.json'), '{"name":"m","scripts":{"test":"vitest"}}\n');
  writeFileSync(join(main, 'api', 'go.mod'), 'module example.com/api\n\ngo 1.22\n');
  writeFileSync(join(main, '.gitignore'), '.env\n');
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
  git(main, 'add', '-A');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'agentdeck/copy', copy);
  return { main, copy, profiles };
}

const endpoint = { recipe: 'db', url: 'postgres://postgres@127.0.0.1:54329/app' };

function wired(profiles: string, viewFails: boolean) {
  const started: string[] = [];
  const run = checkServices({
    registry: {},
    profilesDir: profiles,
    services: {
      ensureServices: () => async (taskId) => {
        started.push(taskId);
        return { value: [endpoint] };
      },
    },
    ...(viewFails
      ? {
          profileIo: {
            viewIo: {
              rootExists: async () => true,
              readdir: async () => {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
              },
              readFile: async () => Buffer.from(''),
            },
          },
        }
      : {}),
  });
  return { run, started };
}

describe('checkServices: copy env behind the check services', () => {
  it('an unread copy profile is a reason, not "ready", and no container is started for it', async () => {
    const { copy, profiles } = repoWithCopy('unread');
    writeFileSync(join(copy, 'api', '.env'), 'DATABASE_URL=postgres://u:p@prod.example:5432/x\n');
    const { run, started } = wired(profiles, true);
    const got = await run({ taskId: 't1', copyDir: copy, project: 'r1' } as never, [
      { service: 'db' },
    ]);
    expect(got).toMatchObject({ unknown: expect.stringContaining('copy env: profile:') });
    expect(started).toEqual([]);
    expect(readFileSync(join(copy, 'api', '.env'), 'utf8')).toContain('prod.example');
  });

  it('stack-root env files are rewritten from the copy profile, and the shared profile file is not written', async () => {
    const { copy, profiles } = repoWithCopy('roots');
    writeFileSync(join(copy, 'api', '.env'), 'DATABASE_URL=postgres://u:p@prod.example:5432/x\n');
    const { run, started } = wired(profiles, false);
    const got = await run({ taskId: 't2', copyDir: copy, project: 'r1' } as never, [
      { service: 'db' },
    ]);
    expect(got).toEqual({ value: [endpoint] });
    expect(started).toEqual(['t2']);
    expect(readFileSync(join(copy, 'api', '.env'), 'utf8')).toBe(`DATABASE_URL=${endpoint.url}\n`);
    expect(readdirSync(profiles)).toEqual([]);
  });
});

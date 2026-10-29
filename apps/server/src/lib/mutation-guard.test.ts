import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeMutation, foreignMutation } from '../../../../tools/mutation-guard.mjs';

const GUARD = resolve(import.meta.dirname, '../../../../tools/mutation-guard.mjs');

/** Одноразовый репозиторий с каталогом журналов mustfail, как его кладёт сам mustfail. */
function repo(): { top: string; dir: string; scope: string } {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'mg-')));
  execFileSync('git', ['init', '-q'], { cwd: top });
  const dir = join(top, '.git', 'mustfail');
  mkdirSync(dir);
  return { top, dir, scope: top.replace(/\\/g, '/').toLowerCase() };
}

function journal(dir: string, pid: number, scope: string, files: string[] = []): void {
  const entries = Object.fromEntries(
    files.map((f) => [f, { before: 'x', written: [], backup: 'b' }]),
  );
  writeFileSync(
    join(dir, `journal-${pid}.json`),
    JSON.stringify({ pid, scope, started: '2026-10-28T00:00:00Z', files: entries }),
  );
}

const live = () => true;
const dead = () => false;

describe('mutation-guard', () => {
  it('нет журналов — дерево чистое', () => {
    const { top } = repo();
    expect(foreignMutation({ cwd: top, env: {}, isAlive: live })).toBeNull();
  });

  it('живой чужой прогон держит дерево — guard называет pid и файлы', () => {
    const { top, dir, scope } = repo();
    journal(dir, 4242, scope, ['a.ts', 'b.ts']);
    const m = foreignMutation({ cwd: top, env: {}, isAlive: live });
    expect(m).toMatchObject({ pid: 4242, files: ['a.ts', 'b.ts'] });
    expect(describeMutation(m!)).toContain('pid 4242');
    expect(describeMutation(m!)).toContain('a.ts');
  });

  it('свой прогон mustfail (MUSTFAIL_PID) не мешает своим проверкам', () => {
    const { top, dir, scope } = repo();
    journal(dir, 4242, scope);
    expect(foreignMutation({ cwd: top, env: { MUSTFAIL_PID: '4242' }, isAlive: live })).toBeNull();
  });

  it('журнал умершего прогона — не мутация: mustfail сам вернёт файлы при следующем старте', () => {
    const { top, dir, scope } = repo();
    journal(dir, 4242, scope);
    expect(foreignMutation({ cwd: top, env: {}, isAlive: dead })).toBeNull();
  });

  it('журнал другого дерева пропускается', () => {
    const { top, dir } = repo();
    journal(dir, 4242, 'c:/elsewhere');
    expect(foreignMutation({ cwd: top, env: {}, isAlive: live })).toBeNull();
  });

  it('нечитаемый журнал — считается мутацией', () => {
    const { top, dir } = repo();
    writeFileSync(join(dir, 'journal-77.json'), '{oops');
    expect(foreignMutation({ cwd: top, env: {}, isAlive: dead })).toMatchObject({
      pid: 77,
      unreadable: true,
    });
  });

  // Настоящий путь: globalSetup в отдельном процессе, живость — настоящий process.kill(pid, 0).
  it('setup() роняет прогон при живом чужом журнале и пропускает свой', () => {
    const { top, dir, scope } = repo();
    journal(dir, process.pid, scope, ['x.ts']);
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import(${JSON.stringify('file:///' + GUARD.replace(/\\/g, '/'))}).then((m) => m.setup())`,
        ],
        {
          cwd: top,
          env,
          encoding: 'utf8',
        },
      );
    const { MUSTFAIL_PID: _drop, ...clean } = process.env;
    const foreign = run(clean);
    expect(foreign.status).not.toBe(0);
    expect(foreign.stderr).toContain(`pid ${process.pid}`);
    expect(run({ ...clean, MUSTFAIL_PID: String(process.pid) }).status).toBe(0);
  });
});

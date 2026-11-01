import { afterEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../../platform/git/git.types.ts';
import { runTool } from '../../platform/run-tool.ts';
import { guardStand, type GuardStand } from '../guard-wiring/__fixtures__/guard-stand.ts';
import { pushUrlOf, repoServerOf } from './unit-view.ts';

/**
 * Адрес пуша публикатора и опроса форжа на настоящем git: из ОБЩЕГО конфига (покопийный слой,
 * который закрывает страж, не читается), `pushurl` главнее `url`, оба ключа — одним процессом
 * git, имя удалённого сверяется дословно (точки и скобки в имени — не синтаксис выражения).
 */

const stands: GuardStand[] = [];
afterEach(() => {
  for (const st of stands.splice(0)) st.remove();
});

function stand(): GuardStand {
  const st = guardStand();
  stands.push(st);
  return st;
}

function counting(): { run: GitRunner; subcommands: string[] } {
  const subcommands: string[] = [];
  const run: GitRunner = (file, args, options) => {
    subcommands.push(String(args[args.indexOf('-C') + 2]));
    return runTool(file, args, options);
  };
  return { run, subcommands };
}

describe('pushUrlOf', () => {
  it('no pushurl: the url of the remote, read from the common config with ONE git config', async () => {
    const st = stand();
    const { run, subcommands } = counting();
    expect(await pushUrlOf(st.copy, 'origin', { env: st.env, run })).toEqual({ value: st.bare });
    expect(subcommands).toEqual(['rev-parse', 'config']);
  });

  it('pushurl wins over url (its first value); the per-copy layer closed by the guard is not read', async () => {
    const st = stand();
    st.g(st.main, 'config', '--add', 'remote.origin.pushurl', 'https://forge.example.test/a.git');
    st.g(st.main, 'config', '--add', 'remote.origin.pushurl', 'https://forge.example.test/b.git');
    st.g(st.main, 'config', 'extensions.worktreeConfig', 'true');
    st.g(st.copy, 'config', '--worktree', 'remote.origin.pushurl', 'agentdeck-closed://stub');
    expect(await pushUrlOf(st.copy, 'origin', { env: st.env })).toEqual({
      value: 'https://forge.example.test/a.git',
    });
  });

  it('a remote name with regex characters matches literally, a look-alike name does not', async () => {
    const st = stand();
    st.g(st.main, 'remote', 'add', 'fork(1)', 'https://forge.example.test/fork.git');
    st.g(st.main, 'remote', 'add', 'upXstream', 'https://forge.example.test/wrong.git');
    expect(await pushUrlOf(st.main, 'fork(1)', { env: st.env })).toEqual({
      value: 'https://forge.example.test/fork.git',
    });
    expect(await pushUrlOf(st.main, 'up.stream', { env: st.env })).toEqual({
      unknown: 'remote up.stream has no url',
    });
  });

  it('repoServerOf: remote and base branch from the ref, the url through the same single read', async () => {
    const st = stand();
    const { run, subcommands } = counting();
    expect(await repoServerOf(st.copy, 'origin/main', { env: st.env, run })).toEqual({
      value: { remote: 'origin', branch: 'main', url: st.bare },
    });
    expect(subcommands).toEqual(['remote', 'rev-parse', 'config']);
  });
});

import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * P28: запрет публикации по префиксу argv не обходится формой вызова. Глобальные опции git
 * перед подкомандой, псевдоним из `-c alias.*`, обёртки (`env`, `command`, `exec`, `nohup`,
 * `nice`, `time`), полный путь к git — всё сводится к той же подкоманде и получает тот же отказ.
 * Каждый вызов — типизированный argv, как его отдаёт переходник; текст не судится.
 */

const ctx: PermitContext = {
  copyRoot: process.cwd(),
  ownedPaths: [],
  deny: {
    paths: [],
    commands: [
      ['git', 'push'],
      ['gh', 'pr', 'create'],
    ],
    mcpTools: [],
    tools: [],
  },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const exec = (argv: string[]): PermissionAsk => ({
  action: 'exec',
  target: argv[0] ?? '',
  argv,
  tool: 'Bash',
  // Только argv: строки нет, судится один разобранный argv (строку проверяет блок ниже).
  display: '',
});

const decide = (argv: string[]) => decidePermit(exec(argv), ctx);

describe('P28 publish deny by argv survives every call form', () => {
  it.each([
    ['plain', ['git', 'push', 'origin', 'main']],
    ['-c pushurl', ['git', '-c', 'remote.origin.pushurl=https://x/y.git', 'push']],
    ['several -c', ['git', '-c', 'a.b=1', '-c', 'core.sshCommand=ssh -i k', 'push', 'origin']],
    ['-C dir', ['git', '-C', '/tmp/copy', 'push']],
    ['--git-dir=', ['git', '--git-dir=/tmp/copy/.git', 'push']],
    ['--git-dir dir', ['git', '--git-dir', '/tmp/copy/.git', 'push']],
    ['--work-tree dir', ['git', '--work-tree', '/tmp/copy', 'push']],
    ['--namespace', ['git', '--namespace', 'ns', 'push']],
    ['--exec-path=', ['git', '--exec-path=/usr/lib/git-core', 'push']],
    ['-p / --paginate / --no-pager', ['git', '-p', '--paginate', '--no-pager', 'push']],
    ['alias via -c', ['git', '-c', 'alias.p=push', 'p', 'origin']],
    ['alias with options', ['git', '-c', 'alias.ship=-c x.y=1 push --force', 'ship']],
    ['alias of alias', ['git', '-c', 'alias.a=b', '-c', 'alias.b=push', 'a']],
    ['alias name case', ['git', '-c', 'alias.Ship=push', 'ship']],
    ['shell alias', ['git', '-c', 'alias.s=!git push origin', 's']],
    ['shell alias chain', ['git', '-c', 'alias.s=!echo ok && git -C . push', 's']],
    ['env', ['env', 'git', 'push']],
    ['env with options', ['env', '-i', '-u', 'HOME', 'A=1', 'git', 'push']],
    ['env -S', ['env', '-S', 'git push origin']],
    ['command', ['command', 'git', 'push']],
    ['command -p', ['command', '-p', 'git', 'push']],
    ['exec -a', ['exec', '-a', 'x', 'git', 'push']],
    ['nohup + nice -n', ['nohup', 'nice', '-n', '5', 'git', 'push']],
    ['time -p', ['time', '-p', 'git', 'push']],
    ['absolute path', ['/usr/bin/git', 'push']],
    ['windows path', ['C:\\Program Files\\Git\\cmd\\git.exe', 'push']],
    ['upper-case exe', ['GIT.EXE', 'push']],
    ['assignment first', ['GIT_TRACE=1', 'git', 'push']],
    ['gh behind env', ['env', 'gh', 'pr', 'create', '--fill']],
    ['gh by path', ['/usr/local/bin/gh', 'pr', 'create']],
    ['sh -c', ['sh', '-c', 'git push origin']],
    ['bash -lc chain', ['/bin/bash', '-lc', 'cd x && git -C . push']],
    ['windows path in shell alias', ['git', '-c', 'alias.w=!C:\\Git\\cmd\\git.exe push', 'w']],
  ])('%s → denied as publishing', (_form, argv) => {
    expect(decide(argv)).toMatchObject({ allow: false, code: 'platform-step' });
  });

  it.each([
    ['other subcommand', ['git', '-c', 'alias.p=push', 'status']],
    ['option value named push', ['git', '-C', 'push', 'status']],
    ['-c value naming push', ['git', '-c', 'x.y=push', 'log']],
    ['alias to fetch', ['git', '-c', 'alias.f=fetch', 'f']],
    ['env without command', ['env']],
    ['not git', ['gitk', 'push']],
    ['gh other', ['env', 'gh', 'pr', 'view']],
    ['sh script file', ['sh', 'push.sh']],
    ['sh -c other', ['bash', '-c', 'git status; echo push']],
  ])('%s → allowed', (_form, argv) => {
    expect(decide(argv)).toMatchObject({ allow: true });
  });
});

/**
 * Вся строка оболочки (P28, проход 3): переходник отдаёт argv только первой команды, а
 * `display` несёт строку целиком — каждая команда цепочки, подстановки, `eval`, запись
 * псевдонима в конфиг и конфиг из окружения судятся тем же префиксом argv.
 */
const line = (command: string) =>
  decidePermit(mapClaudePermission({ tool: 'Bash', input: { command } }), ctx);

describe('P28 the whole shell line is judged, not only its first command', () => {
  it.each([
    ['; chain', 'echo ok; git push'],
    ['&& chain', 'echo ok && git push'],
    ['|| chain', 'false || git push'],
    ['pipe', 'echo x | git push'],
    ['background &', 'sleep 1 & git push'],
    ['newline', 'echo ok\ngit push'],
    ['subshell', '(cd sub && git push)'],
    ['brace group', '{ git push; }'],
    ['if/then', 'if true; then git push; fi'],
    ['for/do', 'for r in a; do git push; done'],
    ['--config-env= alias', 'git --config-env=alias.p=PUSH_ALIAS p'],
    ['--config-env alias', 'git --config-env alias.p=PUSH_ALIAS p'],
    ['--config-env pushurl', 'git --config-env=remote.origin.pushurl=URL fetch'],
    [
      'GIT_CONFIG_KEY env',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p',
    ],
    ['GIT_CONFIG_PARAMETERS', `GIT_CONFIG_PARAMETERS="'alias.p=push'" git p`],
    [
      'export then alias',
      'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push; git p',
    ],
    ['config alias write', 'git config alias.p push'],
    ['config --local', 'git config --local alias.p push'],
    ['config --global --add', 'git config --global --add alias.p "push --force"'],
    ['config --file --replace-all', 'git config --file .git/config --replace-all alias.p push'],
    ['config shell alias', "git config alias.s '!git push origin'"],
    ['config shell alias sh -c', `git config alias.s '!sh -c "git push"'`],
    ['config set', 'git config set alias.p push'],
    ['config pushurl', 'git config --worktree remote.origin.pushurl https://x/y.git'],
    ['config hooksPath', 'git config core.hooksPath /tmp/hooks'],
    ['eval quoted', 'eval "git push"'],
    ['eval words', 'eval git push'],
    ['$( )', 'echo $(git push)'],
    ['"$( )"', 'echo "$(git push origin)"'],
    ['backticks', 'echo `git push`'],
    ['unterminated $(', 'x=$(git push'],
    ['process substitution', 'cat <(git push)'],
    ['rebase -x', 'git rebase -x "git push" main'],
    ['rebase --exec=', 'git rebase --exec="git push" main'],
    ['submodule foreach', 'git submodule foreach "git push"'],
    ['bisect run', 'git bisect run git push'],
    ['find -exec', 'find . -maxdepth 0 -exec git push \\;'],
    ['xargs', 'echo origin | xargs git push'],
    ['sudo -u', 'sudo -u me git push'],
    ['dashed git-push', '/usr/lib/git-core/git-push origin'],
    ['http-push', 'git http-push https://x/y.git main'],
  ])('%s → denied as publishing', (_form, command) => {
    expect(line(command)).toMatchObject({ allow: false, code: 'platform-step' });
  });

  it.each([
    ['config alias to fetch', 'git config alias.f fetch'],
    ['config --get value-pattern', 'git config --get alias.p push'],
    ['config read', 'git config alias.p'],
    ['config --unset', 'git config --unset alias.p'],
    ['--config-env other key', 'git --config-env=core.editor=EDITOR commit'],
    ['quoted literal', 'echo "git push"'],
    ['single-quoted chain', "echo 'git push; x'"],
    ['variable then status', 'echo $HOME && git status'],
    ['single-quoted substitution', "echo '$(git push)'"],
    ['comment', 'echo hi # ; git push'],
    ['rebase -x tests', 'git rebase -x "npm test" main'],
    ['xargs echo', 'xargs echo push'],
  ])('%s → allowed', (_form, command) => {
    expect(line(command)).toMatchObject({ allow: true });
  });
});

describe('P28 git internals are not editable by a session', () => {
  const edit = (target: string) =>
    decidePermit({ action: 'edit', target, tool: 'Edit', display: `Edit ${target}` }, ctx);

  it.each([['.git/config'], ['.git/hooks/pre-push'], ['sub/.git/config'], ['.git']])(
    '%s → denied git-internals',
    (target) => {
      expect(edit(target)).toMatchObject({ allow: false, code: 'git-internals' });
    },
  );

  it('.GIT/config follows the case rule of the file system', () => {
    // Складывает регистр ФС (Windows, macOS) — это тот же `.git`; на Linux — чужой каталог.
    // Ожидание — от самой ФС, не от `pathKey` под тестом (F-122): корень копии с другим
    // регистром букв открывается как тот же каталог (то же устройство и inode)?
    const swapped = [...ctx.copyRoot]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    const same = (a: string, b: string): boolean => {
      const x = statSync(a, { bigint: true });
      const y = statSync(b, { bigint: true });
      return x.dev === y.dev && x.ino === y.ino;
    };
    const folds = swapped !== ctx.copyRoot && existsSync(swapped) && same(ctx.copyRoot, swapped);
    expect(swapped).not.toBe(ctx.copyRoot);
    expect(edit('.GIT/config')).toMatchObject(
      folds ? { allow: false, code: 'git-internals' } : { allow: true },
    );
  });

  it.each([['.github/workflows/ci.yml'], ['.gitignore'], ['src/.gitkeep']])(
    '%s → allowed',
    (target) => {
      expect(edit(target)).toMatchObject({ allow: true });
    },
  );

  it('NotebookEdit and Write reach the same deny through the Claude mapper', () => {
    for (const tool of ['Write', 'NotebookEdit', 'Edit'])
      expect(
        decidePermit(
          mapClaudePermission({
            tool,
            input: { file_path: '.git/config', notebook_path: '.git/config' },
          }),
          ctx,
        ),
        tool,
      ).toMatchObject({ allow: false, code: 'git-internals' });
  });
});

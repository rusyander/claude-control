import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupCommandVerdict } from './group-command.ts';

/**
 * D-9 (25.10): стадия ревью группы распаковала дерево базового коммита своей же
 * копии (`git archive <sha> … | tar -x -C .agent/tmp/…`) и прогнала из него
 * проверку — карточка человеку: путь сквозь распакованное судился как путь через
 * ссылку, ведь в архиве ссылки могли быть. В архиве `git archive` своей копии
 * лежит дерево коммита: нет в нём ссылок (`git ls-tree`, режим 120000) — нет и
 * пути наружу. Настоящий git во временном репозитории; распаковка вне копии и
 * архив не из своего git — по-прежнему человеку.
 */
describe('распаковка дерева своего коммита (D-9)', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'unpack-judge-')));
  const copy = join(base, 'acme-worktrees', 'feat-a');
  const slash = (path: string): string => path.replace(/\\/g, '/');
  const scope = { worktree: copy, cwd: copy, branch: 'feat-a/x', ignored: [] };
  const kind = (command: string, extra: Partial<typeof scope> = {}): string =>
    groupCommandVerdict(command, { ...scope, ...extra }).kind;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: copy,
      encoding: 'utf8',
    }).trim();
  let plain = '';
  let linked = '';

  beforeAll(() => {
    mkdirSync(join(copy, 'inst-docs-ui', 'scripts'), { recursive: true });
    mkdirSync(join(copy, 'shared-ui'), { recursive: true });
    writeFileSync(join(copy, 'inst-docs-ui', 'scripts', 'check_content.mjs'), 'console.log(1);\n');
    writeFileSync(join(copy, 'shared-ui', 'a.txt'), 'a\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    plain = git('rev-parse', '--short=9', 'HEAD');
    // Ссылка в дереве коммита без ссылки на диске: `tar -x` создал бы её.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: copy,
      input: '../../..',
      encoding: 'utf8',
    }).trim();
    git('update-index', '--add', '--cacheinfo', `120000,${blob},inst-docs-ui/out`);
    git('commit', '-qm', 'link');
    linked = git('rev-parse', '--short=9', 'HEAD');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** Дословная команда D-9; `rev` — коммит этой копии. */
  const D9 = (rev: string): string =>
    `mkdir -p .agent/tmp/review-gor55/base-tree && git archive ${rev} inst-docs-ui inst-admin-ui inst-chat-ui shared-ui cp-admin-ui | tar -x -C .agent/tmp/review-gor55/base-tree && node .agent/tmp/review-gor55/base-tree/inst-docs-ui/scripts/check_content.mjs > .agent/tmp/review-gor55/content-check-base.log 2>&1; echo "exit $?"; tail -2 .agent/tmp/review-gor55/content-check-base.log; grep -c "rbac.mdx" .agent/tmp/review-gor55/content-check-base.log`;

  it('D-9: дерево своего коммита без ссылок — распаковка и запуск из него не человеку', () => {
    expect(kind(D9(plain))).not.toBe('danger');
    expect(
      kind(`git archive ${plain} | tar -xvf - -C .agent/tmp/b && cat .agent/tmp/b/shared-ui/a.txt`),
    ).not.toBe('danger');
  });

  it('в дереве коммита есть ссылка — путь сквозь распакованное человеку', () => {
    expect(kind(D9(linked))).toBe('danger');
  });

  it('архив не из своего git или с ключами, что меняют имена и пути, — человеку', () => {
    const run = 'node .agent/tmp/b/inst-docs-ui/scripts/check_content.mjs';
    for (const command of [
      `tar -xf a.tar -C .agent/tmp/b && ${run}`,
      `cat a.tar | tar -x -C .agent/tmp/b && ${run}`,
      `git archive --prefix=../ ${plain} | tar -x -C .agent/tmp/b && ${run}`,
      `git archive --remote=origin ${plain} | tar -x -C .agent/tmp/b && ${run}`,
      `git -C /c/other archive ${plain} | tar -x -C .agent/tmp/b && ${run}`,
      `git archive ${plain} ../x | tar -x -C .agent/tmp/b && ${run}`,
      `git archive ${plain} | tar -xP -C .agent/tmp/b && ${run}`,
      `git archive ${plain} | tar -x --transform=s,^,../, -C .agent/tmp/b && ${run}`,
      `git archive ${plain} | tar -xf other.tar -C .agent/tmp/b && ${run}`,
      `git archive nosuchrev | tar -x -C .agent/tmp/b && ${run}`,
      // git подменён переменной или псевдонимом — архив мог прийти из чужого репозитория.
      `export GIT_DIR=/c/other/.git; git archive ${plain} | tar -x -C .agent/tmp/b && ${run}`,
      `alias git='git -C /c/other'; git archive ${plain} | tar -x -C .agent/tmp/b && ${run}`,
    ]) {
      expect(kind(command), command).toBe('danger');
    }
  });

  it('корень оболочки угадан — архив мог прийти из другого репозитория: человеку', () => {
    const guessed = { worktree: copy, branch: 'feat-a/x', ignored: [] };
    expect(groupCommandVerdict(D9(plain), guessed).kind).toBe('danger');
  });

  it('распаковка вне копии (относительно и абсолютным путём) — человеку', () => {
    for (const command of [
      `git archive ${plain} | tar -x -C ../x`,
      `git archive ${plain} | tar -x -C ${slash(base)}/elsewhere`,
      'tar -xf a.tar -C /c/work/x',
      `tar -xzf a.tgz --directory=${slash(base)}/elsewhere`,
      'unzip a.zip -d ../x',
    ]) {
      expect(kind(command), command).toBe('danger');
    }
    // В своей копии и во временном — сама распаковка своя работа, как прежде.
    expect(kind('tar -xf a.tar -C .agent/tmp/b')).not.toBe('danger');
    expect(kind('tar -xzf a.tgz')).not.toBe('danger');
    expect(kind('unzip a.zip -d inst-docs-ui/vendor')).not.toBe('danger');
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { expandAliasText } from './alias-text.ts';
import { groupCommandVerdict } from './group-command.ts';

// Повторная проверка 24.10 (a): текст с раскрытыми псевдонимами — для сверки
// догона (`main-sync.ts`), которая читает текст, а не слова разбора.
describe('expandAliasText — как раскроет Bash', () => {
  const aliases = {
    grb: 'git rebase',
    g: 'git',
    sudo: 'sudo ',
    ls: 'ls --color',
    a: 'b',
    b: 'a',
  };

  it.each([
    ['grb origin/main', 'git rebase origin/main'],
    ['x; grb y && (grb z) | grb w', 'x; git rebase y && (git rebase z) | git rebase w'],
    ['echo $(grb y) `grb z`', 'echo $(git rebase y) `git rebase z`'],
    ['T=1 grb x', 'T=1 git rebase x'],
    ['if true; then grb x; fi', 'if true; then git rebase x; fi'],
    // Значение кончается пробелом — раскрывается и следующее слово.
    ['sudo grb x', 'sudo  git rebase x'],
    // Имя не раскрывается внутри своей же развёртки.
    ['ls src', 'ls --color src'],
    ['a', 'a'],
    // `eval` исполняет свой аргумент той же оболочкой.
    ["eval 'grb x'", "eval 'git rebase x'"],
    ['echo x > out; g push', 'echo x > out; git push'],
  ])('%s → %s', (command, expanded) => {
    expect(expandAliasText(command, aliases)).toBe(expanded);
  });

  it.each([
    'echo grb',
    "'grb' origin/main",
    '"grb" origin/main',
    '\\grb origin/main',
    'echo # grb x',
    'git log --grep grb',
  ])('не раскрывается: %s', (command) => {
    expect(expandAliasText(command, aliases)).toBe(command);
  });

  it('тело heredoc — данные; команда после него раскрывается', () => {
    expect(expandAliasText('cat <<EOF\ngrb x\nEOF\ngrb y', aliases)).toBe(
      'cat <<EOF\ngrb x\nEOF\ngit rebase y',
    );
  });

  it('псевдонимов нет — команда как написана', () => {
    expect(expandAliasText('grb x', undefined)).toBe('grb x');
    expect(expandAliasText('grb x', {})).toBe('grb x');
  });
});

describe('разбор: псевдоним по словам = развёртка текстом; функция снимка — по телу (d)', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'alias-text-')));
  const copy = join(base, 'shop-worktrees', 'fix-a');
  mkdirSync(copy, { recursive: true });
  const scope = { worktree: copy, cwd: copy, branch: 'fix/a', ignored: [] };
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const aliases = { grb: 'git rebase', g: 'git', ll: 'ls -la', rmf: 'rm -rf', nope: 'echo ' };

  // Расхождение двух путей — тот же класс, что пропуск 24.10: сверка догона и
  // разбор видели бы разные команды.
  it.each([
    'grb origin/main',
    'g push origin main',
    'g push --force origin main',
    'll src',
    'rmf build',
    'rmf /',
    'g status && ll',
    'if true; then g branch -D main; fi',
    "eval 'g push origin main'",
  ])('%s: вердикт по псевдонимам = вердикт по развёртке', (command) => {
    const byWords = groupCommandVerdict(command, { ...scope, aliases }).kind;
    const byText = groupCommandVerdict(expandAliasText(command, aliases), scope).kind;
    expect(byWords).toBe(byText);
  });

  // Псевдоним в конвейере и цепочка через значение с пробелом на конце разбор
  // судит строже развёртки (`other` вместо `routine`) — строже можно, мягче нет.
  const RANK = { routine: 0, other: 1, danger: 2 } as const;
  it.each(['echo x | g push origin fix/a', 'nope g push origin main', 'nope rmf /'])(
    '%s: по псевдонимам не мягче, чем по развёртке',
    (command) => {
      const byWords = groupCommandVerdict(command, { ...scope, aliases }).kind;
      const byText = groupCommandVerdict(expandAliasText(command, aliases), scope).kind;
      expect(RANK[byWords]).toBeGreaterThanOrEqual(RANK[byText]);
    },
  );

  const functions = {
    gsync: 'git fetch && git rebase origin/main',
    clean: 'rm -rf build',
    hello: 'echo hello',
    loop: 'loop',
  };

  it.each(['gsync', 'gsync --now', 'clean', 'x && gsync', "'gsync'"])(
    'функция с git/rm в теле — человеку: %s',
    (command) => {
      expect(groupCommandVerdict(command, { ...scope, functions }).kind).toBe('danger');
    },
  );

  it('безопасное тело — не «само»: решают правила, вызов не прочитан как обычная команда', () => {
    expect(groupCommandVerdict('hello', { ...scope, functions }).kind).toBe('other');
    expect(groupCommandVerdict('hello; rm -rf /', { ...scope, functions }).kind).toBe('danger');
  });

  it('функция, зовущая себя, не зацикливает разбор', () => {
    expect(groupCommandVerdict('loop', { ...scope, functions }).kind).toBe('other');
  });

  it('без снимка имя судится, как написано', () => {
    expect(groupCommandVerdict('gsync', scope).kind).not.toBe('danger');
  });
});

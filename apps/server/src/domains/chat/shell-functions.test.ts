import { describe, expect, it } from 'vitest';
import { shellSnapshot, snapshotNames, type ShellAliasIo } from './shell-aliases.ts';
import { ansiCText, parseFunctions } from './shell-functions.ts';

// Повторная проверка 24.10 (d): функции снимка оболочки судятся как псевдонимы.
describe('parseFunctions — три формы снимка', () => {
  it("CLI 2.1.310: `eval $'…'` строкой на функцию, `printf %q` экранирование", () => {
    const text = [
      '# Functions',
      "eval $'gsync () \\n{ \\n    git fetch && git rebase origin/main\\n}' > /dev/null 2>&1",
      "eval $'say () \\n{ \\n    echo \\'hi\\'\\n}' > /dev/null 2>&1",
    ].join('\n');
    expect(parseFunctions(text)).toEqual({
      gsync: 'git fetch && git rebase origin/main',
      say: "echo 'hi'",
    });
  });

  it('прежние версии: `eval "$(echo \'<base64>\' | base64 -d)"`', () => {
    const body = 'clean () \n{ \n    rm -rf build\n}';
    const line = `eval "$(echo '${Buffer.from(body).toString('base64')}' | base64 -d)" > /dev/null 2>&1`;
    expect(parseFunctions(line)).toEqual({ clean: 'rm -rf build' });
  });

  it('zsh `typeset -f`: определение как есть, `{` той же строкой и однострочное', () => {
    const text = ['gup () {', '\tgit pull --rebase', '}', 'll () { ls -la; }'].join('\n');
    expect(parseFunctions(text)).toEqual({ gup: 'git pull --rebase', ll: 'ls -la;' });
  });

  it('имя `constructor` — обычная функция, не свойство прототипа', () => {
    const functions = parseFunctions('constructor () {\n  rm -rf ~\n}');
    expect(Object.hasOwn(functions, 'constructor')).toBe(true);
    expect(functions['constructor']).toBe('rm -rf ~');
    expect(Object.hasOwn(parseFunctions(''), 'constructor')).toBe(false);
  });

  it('псевдонимы и прочие строки снимка — не функции', () => {
    const text = ["alias -- gp='git push'", 'export PATH=/usr/bin', 'shopt -s expand_aliases'];
    expect(parseFunctions(text.join('\n'))).toEqual({});
  });

  it('ansiCText: восьмеричные, \\x, \\u и управляющие', () => {
    expect(ansiCText('a\\tb\\101\\x42\\u0043\\cA')).toBe('a\tbABC\x01');
  });
});

describe('shellSnapshot — функции и имена одного снимка', () => {
  it('функции из того же файла, что псевдонимы; имена — для правил ask', async () => {
    const text = [
      "alias -- grb='git rebase'",
      "eval $'gsync () \\n{ \\n    git rebase origin/main\\n}' > /dev/null 2>&1",
    ].join('\n');
    const io: ShellAliasIo = {
      list: async () => ['snapshot-bash-300-abcdef.sh'],
      read: async () => text,
    };
    const snapshot = await shellSnapshot(`/fn-${Math.random()}`, io);
    expect(snapshot?.functions).toEqual({ gsync: 'git rebase origin/main' });
    expect(snapshotNames(snapshot)).toEqual(['grb', 'gsync']);
    expect(snapshotNames(undefined)).toEqual([]);
  });
});

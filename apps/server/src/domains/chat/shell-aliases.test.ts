import { describe, expect, it } from 'vitest';
import { parseAliases, shellAliases, type ShellAliasIo } from './shell-aliases.ts';

/**
 * Псевдонимы снимка оболочки CLI (раунд 10): снимок пишет `unalias -a`, затем
 * `alias -- имя='значение'` из `.bashrc`, затем снимает конфликтующие с
 * функциями (`unalias pkill`). Суд команды видит то, что раскроет оболочка.
 */
describe('parseAliases — строки снимка по порядку', () => {
  const snapshot = [
    "alias -- old='rm -rf /'",
    'unalias -a 2>/dev/null || true',
    'shopt -s expand_aliases',
    "alias -- gp='git push'",
    "alias -- pk='pkill node'",
    "alias -- q='echo '\\''hi'\\'''",
    "alias ll='ls -la'",
    'alias -- e=""',
    'unalias pk 2>/dev/null || true',
    'gp() { git push "$@"; }',
  ].join('\n');

  it("берёт `alias --` и `alias`, кавычку `'\\''` внутри значения", () => {
    expect(parseAliases(snapshot)).toEqual({
      gp: 'git push',
      q: "echo 'hi'",
      ll: 'ls -la',
      e: '',
    });
  });

  it('`unalias -a` снимает прежние, `unalias имя` — одно', () => {
    const aliases = parseAliases(snapshot);
    expect(aliases.old).toBeUndefined();
    expect(aliases.pk).toBeUndefined();
  });
});

describe('shellAliases — самый новый снимок каталога CLI', () => {
  const io = (files: Record<string, string>, reads: string[] = []): ShellAliasIo => ({
    list: async () => Object.keys(files),
    read: async (file) => {
      reads.push(file);
      const name = file.replace(/^.*[\\/]/, '');
      if (!(name in files)) throw new Error('ENOENT');
      return files[name] as string;
    },
  });

  it('новый по метке времени, а не по порядку списка; читается раз на снимок', async () => {
    const reads: string[] = [];
    const files = {
      'snapshot-bash-100-aaaaaa.sh': "alias -- gp='git pull'",
      'snapshot-bash-200-bbbbbb.sh': "alias -- gp='git push'",
      'snapshot-bash-150-cccccc.sh': "alias -- gp='git log'",
      'notes.txt': "alias -- gp='rm -rf ~'",
    };
    const dir = `/cfg-${Math.random()}`;
    expect(await shellAliases(dir, io(files, reads))).toEqual({ gp: 'git push' });
    expect(await shellAliases(dir, io(files, reads))).toEqual({ gp: 'git push' });
    expect(reads).toHaveLength(1);
  });

  it('снимка нет или он не читается — псевдонимов не знаем', async () => {
    expect(await shellAliases(`/none-${Math.random()}`, io({}))).toBeUndefined();
    const broken: ShellAliasIo = {
      list: async () => ['snapshot-zsh-5-abcdef.sh'],
      read: async () => {
        throw new Error('EACCES');
      },
    };
    expect(await shellAliases(`/broken-${Math.random()}`, broken)).toBeUndefined();
    const missing: ShellAliasIo = {
      list: async () => {
        throw new Error('ENOENT');
      },
      read: async () => '',
    };
    expect(await shellAliases(`/missing-${Math.random()}`, missing)).toBeUndefined();
  });
});

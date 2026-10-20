import { describe, expect, it } from 'vitest';
import { procPortHolders } from './ports.ts';

/**
 * Linux без `lsof` (alpine 20.10): «Освободить порт» не находил держателя и
 * отвечал «никто не слушает». Настоящий `/proc` проверяет прогон
 * actions-project-runner в Linux-контейнере; здесь — разбор таблиц.
 */
const TCP_HEAD =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';

function fakeProc(files: Record<string, string>, links: Record<string, string>) {
  return {
    readFileSync: (file: string) => {
      const text = files[file];
      if (text === undefined) throw new Error(`ENOENT ${file}`);
      return text;
    },
    readdirSync: (dir: string) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const key of Object.keys(links)) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0] ?? '');
      }
      if (names.size === 0) throw new Error(`ENOENT ${dir}`);
      return [...names];
    },
    readlinkSync: (link: string) => {
      const target = links[link];
      if (target === undefined) throw new Error(`EACCES ${link}`);
      return target;
    },
  };
}

describe('procPortHolders: держатели порта по /proc', () => {
  it('слушающий сокет порта (IPv4 и IPv6) → процессы с его inode; чужой порт и не LISTEN — мимо', () => {
    const io = fakeProc(
      {
        '/p/net/tcp':
          TCP_HEAD +
          '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1\n' +
          '   1: 0100007F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1\n' +
          '   2: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1\n',
        '/p/net/tcp6':
          TCP_HEAD +
          '   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1\n',
      },
      {
        '/p/10/fd/3': 'socket:[111]',
        '/p/11/fd/4': 'socket:[222]',
        '/p/12/fd/5': 'socket:[333]',
        '/p/13/fd/0': '/dev/null',
        '/p/13/fd/7': 'socket:[444]',
        '/p/self/fd/1': 'socket:[111]',
      },
    );
    expect(procPortHolders(8080, '/p', io).sort()).toEqual([10, 13]);
  });

  it('нет таблиц или нет слушателя — пусто, без исключения', () => {
    expect(procPortHolders(8080, '/p', fakeProc({}, {}))).toEqual([]);
    const io = fakeProc({ '/p/net/tcp': TCP_HEAD }, { '/p/10/fd/3': 'socket:[111]' });
    expect(procPortHolders(8080, '/p', io)).toEqual([]);
  });
});

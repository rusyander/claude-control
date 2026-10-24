import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCimCommandTable,
  planPathSweep,
  sweepPathProcesses,
  type CommandRow,
} from './path-sweep.ts';
import { filetimeFromMs, type KillTarget } from '../kill-tree.mjs';
import type { SpawnRecord } from '../cli-spawn/spawn-registry.ts';

/**
 * Добор процессов копии после паузы группы (N1b/N1c, 23.10): vite копии на
 * :5173 и цепочка tests-cli → vitest жили после паузы. Признак — путь копии в
 * командной строке, с границей до и после пути. План — на подменённом снимке,
 * снятие — на настоящих процессах внутри временной папки и рядом с ней.
 */

const at = (ms: number): bigint => filetimeFromMs(ms);
const row = (pid: number, ppid: number, command: string, created = at(1000 + pid)): CommandRow => ({
  pid,
  ppid,
  created,
  command,
});
/** Запись реестра запусков: процесс жив, запущен в `ms` (по умолчанию — как `row`). */
const rec = (pid: number, ms = 1000 + pid, exitedAt?: number): SpawnRecord => ({
  pid,
  spawnedAt: ms,
  ...(exitedAt === undefined ? {} : { exitedAt }),
});
/** Всё в снимке запустил сервер — проверка о пути, не о владельце. */
const all = (table: readonly CommandRow[]): { selfPid: number; spawned: SpawnRecord[] } => ({
  selfPid: 999,
  spawned: table.map((item) => rec(item.pid)),
});

describe('planPathSweep', () => {
  const copy = 'C:\\work\\wt\\feat-1';

  it('снимает процессы с путём копии, новые вперёд', () => {
    const table = [
      row(10, 1, 'node C:\\work\\wt\\feat-1\\node_modules\\vite\\bin\\vite.js'),
      row(
        20,
        10,
        '"C:\\Program Files\\nodejs\\node.exe" c:/work/wt/feat-1/tools/tests-cli.mjs run',
      ),
      row(30, 1, 'cmd /c cd /d "C:\\work\\wt\\feat-1" && pnpm dev'),
    ];
    expect(planPathSweep(table, copy, all(table))).toEqual([30, 20, 10]);
  });

  it('путь — целиком: feat-10 и feat-1-old не задеты', () => {
    const table = [
      row(10, 1, 'node C:\\work\\wt\\feat-10\\vite.js'),
      row(11, 1, 'node C:\\work\\wt\\feat-1-old\\vite.js'),
      row(12, 1, 'node D:\\backup\\work\\wt\\feat-1\\vite.js'),
      row(13, 1, 'node C:\\work\\wt\\feat-1'),
    ];
    expect(planPathSweep(table, copy, all(table))).toEqual([13]);
  });

  it('граница перед путём POSIX: /var/tmp/wt не задевает /tmp/wt', () => {
    const table = [
      row(10, 1, 'node /var/tmp/wt/feat/vite.js'),
      row(11, 1, 'node /tmp/wt/feat/vite.js'),
      row(12, 1, 'node --root=/tmp/wt/feat'),
    ];
    expect(planPathSweep(table, '/tmp/wt/feat', all(table))).toEqual([12, 11]);
  });

  it('регистр складывается только у путей Windows', () => {
    const posix = [row(10, 1, 'node /TMP/WT/feat/x')];
    expect(planPathSweep(posix, '/tmp/wt/feat', all(posix))).toEqual([]);
    const windows = [row(10, 1, 'node C:/WORK/WT/FEAT-1/x')];
    expect(planPathSweep(windows, copy, all(windows))).toEqual([10]);
  });

  it('сам сервер и его предки не снимаются, даже из той же папки', () => {
    const table = [
      row(5, 1, 'cmd /c cd C:\\work\\wt\\feat-1 && pnpm dev', at(100)),
      row(6, 5, 'node C:\\work\\wt\\feat-1\\apps\\server\\src\\index.ts', at(200)),
      row(7, 6, 'node C:\\work\\wt\\feat-1\\vite.js', at(300)),
    ];
    expect(planPathSweep(table, copy, { selfPid: 6 })).toEqual([7]);
  });

  it('предок по освободившемуся номеру (моложе ребёнка) не защищён', () => {
    const table = [
      row(5, 1, 'node C:\\work\\wt\\feat-1\\stray.js', at(900)),
      row(6, 5, 'node C:\\work\\wt\\feat-1\\server.js', at(200)),
    ];
    expect(planPathSweep(table, copy, { selfPid: 6, spawned: [rec(5, 900)] })).toEqual([5]);
  });

  it('мелкий корень не метётся: C:\\, C:\\work, /home', () => {
    const table = [row(10, 1, 'node C:\\work\\x.js'), row(11, 1, 'node /home/x.js')];
    expect(planPathSweep(table, 'C:\\', { selfPid: 999 })).toEqual([]);
    expect(planPathSweep(table, 'C:\\work', { selfPid: 999 })).toEqual([]);
    expect(planPathSweep(table, '/home', { selfPid: 999 })).toEqual([]);
    expect(planPathSweep(table, '/', { selfPid: 999 })).toEqual([]);
  });

  /**
   * F-34: путь копии в командной строке есть и у редактора человека, открытого
   * на копии («открыть в редакторе»), и у его tsserver, и у команды из его
   * терминала. Снимается только дерево панели (CLI группы) и сироты, чей
   * родитель записан в реестре запусков (RF-BGCD-09); чужое дерево и всё под
   * редактором/терминалом — нет.
   */
  describe('чужое дерево не снимается (F-34)', () => {
    const g0 = 'C:/work/copies/g0';
    const table = [
      row(4, 2, 'C:\\Windows\\explorer.exe', at(50)),
      row(5, 4, 'cmd /c pnpm dev', at(100)),
      row(6, 5, 'node C:/work/agentdeck/apps/server/src/index.ts', at(200)),
      // Человек: редактор из меню «Пуск», его tsserver и команда из его терминала.
      row(
        40,
        4,
        '"C:\\Program Files\\Microsoft VS Code\\Code.exe" --folder-uri file:///C:/work/copies/g0',
        at(500),
      ),
      row(
        41,
        40,
        'node "C:\\Program Files\\Microsoft VS Code\\resources\\tsserver.js" --project C:/work/copies/g0',
        at(510),
      ),
      row(30, 4, '"C:\\Program Files\\Git\\usr\\bin\\mintty.exe" --nodaemon', at(400)),
      row(31, 30, 'bash', at(410)),
      row(32, 31, 'node C:/work/copies/g0/scripts/x.mjs', at(420)),
      // Редактор, открытый `code .`: запускатель вышел, родителя нет, — всё равно редактор.
      row(
        50,
        77,
        'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe C:/work/copies/g0',
        at(600),
      ),
      row(
        51,
        50,
        'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe --type=utility C:/work/copies/g0',
        at(610),
      ),
      // Сторонний процесс старше панели (служба, сеанс до запуска панели).
      row(60, 3, 'node C:/work/copies/g0/old-watch.js', at(150)),
      // Группа: потомок CLI под сервером и сирота после смерти оболочки CLI.
      row(7, 6, 'claude --print', at(300)),
      row(8, 7, 'node C:/work/copies/g0/node_modules/vite/bin/vite.js', at(700)),
      // Оболочка CLI (88) записана реестром и вышла в 715 — её сирота 9 своя.
      row(9, 88, 'node C:/work/copies/g0/tools/tests-cli.mjs run', at(710)),
      row(10, 9, 'node C:/work/copies/g0/node_modules/vitest/vitest.mjs', at(720)),
      // RF-BGCD-09: человек поднял процесс в копии ПОСЛЕ старта панели, его
      // запускатель (99) вышел. Прежде «моложе сервера — наш» снимал и его.
      row(70, 99, 'node C:/work/copies/g0/human-watch.js', at(800)),
      // Номер вышедшей оболочки 88 достался чужому, и тот завёл ребёнка позже.
      row(71, 88, 'node C:/work/copies/g0/reused-parent.js', at(9_000)),
    ];
    const spawned = [rec(7, 300), rec(88, 650, 715)];

    it('снимаются только процессы группы: потомки панели и сироты записанного запуска', () => {
      expect(planPathSweep(table, g0, { selfPid: 6, spawned })).toEqual([10, 9, 8]);
    });

    it('сирота без записи в реестре цела, сколько бы ему ни было лет (RF-BGCD-09)', () => {
      expect(planPathSweep(table, g0, { selfPid: 6, spawned: [] })).toEqual([8]);
    });

    it('записанный, но живой номер с другим временем создания — не наш', () => {
      const stray = [row(12, 1, 'node C:/work/copies/g0/x.js', at(5_000))];
      expect(planPathSweep(stray, g0, { selfPid: 6, spawned: [rec(12, 1_000)] })).toEqual([]);
      expect(planPathSweep(stray, g0, { selfPid: 6, spawned: [rec(12, 5_500)] })).toEqual([12]);
    });

    it('POSIX: сирота у init своя только по записи или метке; терминал человека — нет', () => {
      const posix = [
        row(1, 0, '/sbin/init', at(10)),
        row(20, 1, '/usr/bin/gnome-terminal-server', at(100)),
        row(21, 20, 'bash', at(110)),
        row(6, 21, 'node /home/me/agentdeck/apps/server/src/index.ts', at(200)),
        row(22, 20, 'bash', at(300)),
        row(23, 22, 'node /home/me/copies/g0/x.mjs', at(310)),
        row(30, 1, 'node /home/me/copies/g0/node_modules/vite/bin/vite.js', at(400)),
        row(31, 1, '/usr/share/code/code /home/me/copies/g0', at(410)),
      ];
      const g = '/home/me/copies/g0';
      expect(planPathSweep(posix, g, { selfPid: 6, platform: 'linux' })).toEqual([]);
      expect(
        planPathSweep(posix, g, { selfPid: 6, platform: 'linux', marked: () => true }),
      ).toEqual([30]);
      expect(
        planPathSweep(posix, g, { selfPid: 6, platform: 'linux', spawned: [rec(30, 400)] }),
      ).toEqual([30]);
    });
  });

  /**
   * RF-BGCD-09: на Linux-столе `systemd --user` — субжнец: сирота группы уходит к
   * нему, обход доходит до процесса старше сервера (часто — его предка), и сирота
   * уцелевал — ровно случай N1b. Окружение читается (`/proc/<pid>/environ`), и
   * метка группы в нём — доказательство. Linux проверен через шов `readEnv`:
   * хоста Linux у прогона нет.
   */
  describe('метка группы в окружении — доказательство (Linux, RF-BGCD-09)', () => {
    const MARK = 'AGENTDECK_TESTS_RUNS_AT_DELIVERY';
    const g0 = '/home/me/copies/g0';
    const table = [
      row(1, 0, '/sbin/init', at(10)),
      row(2, 1, '/usr/lib/systemd/systemd --user', at(20)),
      row(20, 2, '/usr/bin/gnome-terminal-server', at(100)),
      row(21, 20, 'bash', at(110)),
      row(6, 21, 'node /home/me/agentdeck/apps/server/src/index.ts', at(200)),
      // Сироты у субжнеца: группы (с меткой) и человека (терминал закрыт, без метки).
      row(30, 2, `node ${g0}/node_modules/vite/bin/vite.js`, at(400)),
      row(31, 2, `node ${g0}/scripts/dev.mjs`, at(410)),
      // Метка есть, но цепочка идёт через терминал человека — человека.
      row(22, 20, 'bash', at(300)),
      row(23, 22, `node ${g0}/x.mjs`, at(310)),
    ];
    const environ: Record<number, string> = {
      30: `PATH=/usr/bin\0${MARK}=1\0`,
      31: 'PATH=/usr/bin\0',
      23: `${MARK}=1`,
    };

    it('сирота группы у субжнеца снимается, сирота человека — нет', async () => {
      const sent: number[] = [];
      const killed = await sweepPathProcesses(g0, {
        platform: 'linux',
        selfPid: 6,
        mark: MARK,
        readEnv: (pid) => environ[pid],
        readTable: () => Promise.resolve(table),
        kill: (pid) => sent.push(pid),
      });
      expect(killed).toEqual([30]);
      expect(sent).toEqual([30]);
    });

    it('без метки предок сервера — соседнее дерево, не снимается', () => {
      expect(planPathSweep(table, g0, { selfPid: 6 })).toEqual([]);
      expect(planPathSweep(table, g0, { selfPid: 6, marked: (pid) => pid === 30 })).toEqual([30]);
    });

    it('пустое значение метки и чужая переменная с тем же началом — не метка', async () => {
      const killed = await sweepPathProcesses(g0, {
        platform: 'linux',
        selfPid: 6,
        mark: MARK,
        readEnv: (pid) => (pid === 30 ? `${MARK}=\0${MARK}_X=1` : undefined),
        readTable: () => Promise.resolve(table),
        kill: () => undefined,
      });
      expect(killed).toEqual([]);
    });
  });

  it('процесс без времени создания не снимается', () => {
    expect(
      planPathSweep([row(10, 1, 'node C:\\work\\wt\\feat-1\\x', 0n)], copy, { selfPid: 999 }),
    ).toEqual([]);
  });
});

describe('parseCimCommandTable', () => {
  it('командная строка в base64 переживает пробелы и переводы строк', () => {
    const command = 'node "C:\\a b\\x.js"\n--flag';
    const text = `12 4 133000000000000000 ${Buffer.from(command, 'utf8').toString('base64')}\r\n4 0 0 \r\n`;
    expect(parseCimCommandTable(text)).toEqual([
      { pid: 12, ppid: 4, created: 133000000000000000n, command },
      { pid: 4, ppid: 0, created: 0n, command: '' },
    ]);
  });
});

describe('sweepPathProcesses', () => {
  it('Windows: по дескриптору со временем создания; помощника нет — ничего', async () => {
    const table = [row(10, 1, 'node C:\\work\\wt\\feat-1\\x'), row(11, 1, 'node C:\\other\\y\\z')];
    const seen: KillTarget[][] = [];
    const killed = await sweepPathProcesses('C:\\work\\wt\\feat-1', {
      platform: 'win32',
      selfPid: 999,
      spawned: [rec(10)],
      readTable: () => Promise.resolve(table),
      terminate: (targets) => {
        seen.push([...targets]);
        return new Map([[10, 'killed']]);
      },
    });
    expect(killed).toEqual([10]);
    expect(seen).toEqual([[{ pid: 10, created: table[0]!.created }]]);
    expect(
      await sweepPathProcesses('C:\\work\\wt\\feat-1', {
        platform: 'win32',
        selfPid: 999,
        spawned: [rec(10)],
        readTable: () => Promise.resolve(table),
        terminate: () => undefined,
      }),
    ).toEqual([]);
  });

  it('Windows: метка читается разом и только у кандидатов с путём копии', async () => {
    const table = [
      row(10, 1, 'node C:\\work\\wt\\feat-1\\x'),
      row(11, 1, 'node C:\\work\\wt\\feat-1\\y'),
      row(12, 1, 'node C:\\other\\y\\z'),
      row(13, 1, 'C:\\Windows\\explorer.exe'),
      row(14, 13, 'node C:\\work\\wt\\feat-1\\under-explorer'),
    ];
    const asked: Array<[number[], string]> = [];
    const killed = await sweepPathProcesses('C:\\work\\wt\\feat-1', {
      platform: 'win32',
      selfPid: 999,
      spawned: [],
      mark: 'AGENTDECK_TESTS_RUNS_AT_DELIVERY',
      readMarks: (rows, name) => {
        asked.push([rows.map((item) => item.pid), name]);
        return Promise.resolve(new Map([[11, true]]));
      },
      readTable: () => Promise.resolve(table),
      terminate: (targets) => new Map(targets.map(({ pid }) => [pid, 'killed' as const])),
    });
    expect(asked).toEqual([[[10, 11], 'AGENTDECK_TESTS_RUNS_AT_DELIVERY']]);
    expect(killed).toEqual([11]);
  });

  it('POSIX: SIGTERM по номеру; снимка нет — пусто', async () => {
    const sent: Array<[number, string]> = [];
    const killed = await sweepPathProcesses('/tmp/wt/feat', {
      platform: 'linux',
      selfPid: 999,
      spawned: [rec(10)],
      readTable: () => Promise.resolve([row(10, 1, 'node /tmp/wt/feat/x')]),
      kill: (pid, signal) => sent.push([pid, signal]),
    });
    expect(killed).toEqual([10]);
    expect(sent).toEqual([[10, 'SIGTERM']]);
    expect(
      await sweepPathProcesses('/tmp/wt/feat', {
        platform: 'linux',
        readTable: () => Promise.resolve(undefined),
      }),
    ).toEqual([]);
  });

  // F-69: снимок CIM идёт ~1 с; группу за это время сняли с паузы — её свежие процессы в
  // той же копии добор не трогает: снимается только то, что жило к моменту вызова.
  for (const platform of ['win32', 'linux'] as const) {
    it(`${platform}: процесс, заведённый после вызова (группу сняли с паузы), не снимается (F-69)`, async () => {
      const dir = platform === 'win32' ? 'C:\\work\\wt\\feat-1' : '/tmp/wt/feat';
      const oldMs = Date.now() - 5_000;
      const old = row(10, 1, `node ${dir}/old.js`, at(oldMs));
      // Оба запущены сервером: свежий отсекает срез, не реестр.
      const spawned = [rec(10, oldMs), rec(20, Date.now() + 40)];
      const readTable = async (): Promise<CommandRow[]> => {
        await new Promise((tick) => setTimeout(tick, 40));
        return [old, row(20, 1, `node ${dir}/node_modules/vite/bin/vite.js`, at(Date.now()))];
      };
      const asked: number[] = [];
      const killed = await sweepPathProcesses(dir, {
        platform,
        selfPid: 999,
        spawned,
        readTable,
        terminate: (targets) => {
          asked.push(...targets.map(({ pid }) => pid));
          return new Map(targets.map(({ pid }) => [pid, 'killed' as const]));
        },
        kill: (pid) => asked.push(pid),
      });
      expect(killed).toEqual([10]);
      expect(asked).toEqual([10]);
    });
  }

  // F-99: на POSIX сигнал уходит по голому номеру. Номер, за который между снимком и сигналом
  // встал другой процесс (другое время создания), не трогается; тот же процесс — снимается.
  it('linux: номер занят новым процессом к моменту сигнала — не снимается (F-99)', async () => {
    const dir = '/tmp/wt/feat';
    const bornMs = Date.now() - 60_000;
    const born = at(bornMs);
    const first = [row(10, 1, `node ${dir}/a.js`, born), row(11, 1, `node ${dir}/b.js`, born)];
    const second = [
      row(10, 1, `node ${dir}/a.js`, born),
      row(11, 1, 'sshd: user@pts/0', at(Date.now() - 1_000)),
    ];
    let reads = 0;
    const asked: number[] = [];
    const killed = await sweepPathProcesses(dir, {
      platform: 'linux',
      selfPid: 999,
      spawned: [rec(10, bornMs), rec(11, bornMs)],
      readTable: async () => (reads++ === 0 ? first : second),
      kill: (pid) => asked.push(pid),
    });
    expect(killed).toEqual([10]);
    expect(asked).toEqual([10]);
  });
});

/** Настоящий снимок и снятие: процесс в копии снят, процесс в соседней папке жив. */
describe('sweepPathProcesses на настоящих процессах', () => {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((tick) => setTimeout(tick, 100));
    }
    return check();
  };

  it('снят только процесс копии', async () => {
    const base = mkdtempSync(join(tmpdir(), 'path-sweep-'));
    const copy = join(base, 'copy');
    const sibling = join(base, 'copy-2');
    mkdirSync(copy);
    mkdirSync(sibling);
    const script = (dir: string): string => {
      const file = join(dir, 'dev-server.cjs');
      writeFileSync(
        file,
        `require('fs').writeFileSync(${JSON.stringify(join(dir, 'up'))}, '1');\nsetInterval(() => {}, 1000);\n`,
      );
      return file;
    };
    const inCopy = spawn(process.execPath, [script(copy)], { stdio: 'ignore', windowsHide: true });
    const beside = spawn(process.execPath, [script(sibling)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(
        await waitFor(
          () => existsSync(join(copy, 'up')) && existsSync(join(sibling, 'up')),
          15_000,
        ),
      ).toBe(true);

      const killed = await sweepPathProcesses(copy);

      expect(killed).toEqual([inCopy.pid]);
      expect(await waitFor(() => !isAlive(inCopy.pid!), 10_000)).toBe(true);
      expect(isAlive(beside.pid!)).toBe(true);
    } finally {
      inCopy.kill();
      beside.kill();
      await waitFor(() => !isAlive(beside.pid!) && !isAlive(inCopy.pid!), 5_000);
      rmSync(base, { recursive: true, force: true });
    }
  }, 40_000);
});

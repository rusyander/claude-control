import { describe, it, expect, vi } from 'vitest';
import {
  filetimeFromMs,
  killChildProcessTree,
  killProcessTree,
  parsePosixProcessTable,
  parseKillOutcomes,
  parseProcessTable,
  planLeftoverKill,
  planTreeKill,
  readPosixProcessTable,
  readProcessTable,
  REUSE_SLACK_MS,
  terminateByHandle,
  type ProcessRow,
} from './kill-tree.mjs';

/**
 * Обход дерева на подменённой таблице процессов.
 *
 * Ради чего: `taskkill /T` строил дерево только по номеру родителя, и 2026-09-27
 * уборка тестового прогона сняла живого сторожа стенда — сироту, чей давно
 * мёртвый родитель отдал номер нашему процессу. Здесь ровно такая таблица.
 * Время в строках — как отдаёт снимок Windows: тики FILETIME.
 */

const T0 = Date.UTC(2026, 8, 27, 3, 16, 0);
const at = (secondsAfterT0: number): bigint => filetimeFromMs(T0 + secondsAfterT0 * 1000);
const row = (pid: number, ppid: number, created: bigint): ProcessRow => ({ pid, ppid, created });

/**
 * Сцена происшествия: сторож 500 запущен отвязанно в t=0 процессом 900, который
 * давно умер; у сторожа свои дети (сервер 501, фронт 502). В t=100 наш сервер
 * запускает оболочку и получает освободившийся номер 900. Под ней — CLI 901,
 * его MCP-сервер 902 и оболочка 903 с командой 904.
 */
const SCENE: ProcessRow[] = [
  row(0, 0, 0n),
  row(4, 0, at(-1000)),
  row(500, 900, at(0)),
  row(501, 500, at(1)),
  row(502, 500, at(2)),
  row(900, 7, at(100)),
  row(901, 900, at(101)),
  row(902, 901, at(102)),
  row(903, 901, at(103)),
  row(904, 903, at(104)),
];

describe('planTreeKill — кто наш потомок', () => {
  it('сирота с унаследованным номером родителя и более ранним созданием — НЕ потомок', () => {
    const { pids } = planTreeKill(SCENE, 900, { selfPid: -1 });
    expect(pids).not.toContain(500);
    expect(pids).not.toContain(501);
    expect(pids).not.toContain(502);
  });

  it('настоящие дети и внуки входят, листьями вперёд, корень последним', () => {
    const { pids, skipped } = planTreeKill(SCENE, 900, { selfPid: -1 });
    expect(skipped).toBeUndefined();
    expect([...pids].sort()).toEqual([900, 901, 902, 903, 904]);
    expect(pids.at(-1)).toBe(900);
    const before = (a: number, b: number): boolean => pids.indexOf(a) < pids.indexOf(b);
    expect(before(904, 903)).toBe(true);
    expect(before(903, 901)).toBe(true);
    expect(before(902, 901)).toBe(true);
  });

  it('ребёнок, созданный в тот же тик, что и родитель, — потомок (`>=`, не `>`)', () => {
    const table = [row(10, 1, at(5)), row(11, 10, at(5))];
    expect(planTreeKill(table, 10, { selfPid: -1 }).pids).toEqual([11, 10]);
  });

  it('проверка идёт от НЕПОСРЕДСТВЕННОГО родителя: внук-сирота под настоящим ребёнком отсекается', () => {
    // 21 — настоящий ребёнок 20; 22 указывает на 21, но создан раньше 21.
    const table = [row(20, 1, at(10)), row(21, 20, at(20)), row(22, 21, at(15))];
    expect(planTreeKill(table, 20, { selfPid: -1 }).pids).toEqual([21, 20]);
  });

  it('процесс без известного времени создания в дерево не входит', () => {
    const table = [row(30, 1, at(10)), row(31, 30, 0n), row(32, 31, at(12))];
    expect(planTreeKill(table, 30, { selfPid: -1 }).pids).toEqual([30]);
  });

  it('свой процесс не снимается никогда', () => {
    const table = [row(40, 1, at(10)), row(41, 40, at(11))];
    expect(planTreeKill(table, 40, { selfPid: 41 }).pids).toEqual([40]);
    expect(planTreeKill(table, 40, { selfPid: 40 }).pids).toEqual([41]);
  });

  it('петля в таблице (Idle сам себе родитель, взаимные ссылки) не вешает обход', () => {
    const table = [row(0, 0, 0n), row(50, 51, at(1)), row(51, 50, at(1))];
    expect([...planTreeKill(table, 50, { selfPid: -1 }).pids].sort()).toEqual([50, 51]);
  });
});

describe('planTreeKill — корень', () => {
  it('корень создан позже, чем был записан как наш, — номер занят чужим, не снимаем ничего', () => {
    const spawnedAt = T0 + 50_000; // записали в t=50, а процесс с номером 900 создан в t=100
    expect(planTreeKill(SCENE, 900, { spawnedAt, selfPid: -1 })).toEqual({
      pids: [],
      skipped: 'root-reused',
    });
  });

  it('корень создан до записи (или в пределах запаса на часы) — снимаем', () => {
    const recordedRightAfter = T0 + 100_000 + 5;
    expect(
      planTreeKill(SCENE, 900, { spawnedAt: recordedRightAfter, selfPid: -1 }).pids,
    ).toHaveLength(5);
    const clockSkewed = T0 + 100_000 - (REUSE_SLACK_MS - 10);
    expect(planTreeKill(SCENE, 900, { spawnedAt: clockSkewed, selfPid: -1 }).pids).toHaveLength(5);
  });

  it('корня нет в снимке — не снимаем никого, и детей по его номеру тоже', () => {
    const table = [row(61, 60, at(5))];
    expect(planTreeKill(table, 60, { selfPid: -1 })).toEqual({ pids: [], skipped: 'root-absent' });
  });

  it('у корня нет времени создания — доказать нечем, не снимаем', () => {
    const table = [row(70, 1, 0n), row(71, 70, at(5))];
    expect(planTreeKill(table, 70, { selfPid: -1 })).toEqual({ pids: [], skipped: 'root-unknown' });
  });
});

describe('parseProcessTable', () => {
  it('строки `pid ppid created`, CRLF и мусор вокруг не мешают', () => {
    expect(parseProcessTable('#< CLIXML\r\n4 0 123\r\n 500 900 134000000000000000 \r\n')).toEqual([
      row(4, 0, 123n),
      row(500, 900, 134000000000000000n),
    ]);
  });

  it('пустой вывод — снимка нет', () => {
    expect(parseProcessTable('')).toBeUndefined();
  });
});

describe('killProcessTree — сигналы', () => {
  it('Windows: сигнал каждому номеру дерева листьями вперёд, без `/T`, сирота жива', () => {
    const kill = vi.fn();
    const marked: number[] = [];
    const killed = killProcessTree(
      900,
      { selfPid: -1, onKill: (pid) => marked.push(pid) },
      { platform: 'win32', readTable: () => SCENE, kill },
    );
    expect(killed).toEqual(marked);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual(killed);
    expect(kill.mock.calls.every(([, signal]) => signal === 'SIGKILL')).toBe(true);
    expect(killed).not.toContain(500);
  });

  it('Windows без снимка: только корень — и то лишь без проверки времени', () => {
    const kill = vi.fn();
    const impl = { platform: 'win32', readTable: () => undefined, kill };
    expect(killProcessTree(900, { selfPid: -1 }, impl)).toEqual([900]);
    expect(killProcessTree(900, { selfPid: -1, spawnedAt: T0 }, impl)).toEqual([]);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('отказ сигнала (процесса уже нет) не выходит наружу', () => {
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    expect(() =>
      killProcessTree(900, { selfPid: -1 }, { platform: 'win32', readTable: () => SCENE, kill }),
    ).not.toThrow();
  });

  it('POSIX: своя группа — одним сигналом группе; нет группы — самому процессу', () => {
    const kill = vi.fn();
    killProcessTree(77, { group: true }, { platform: 'linux', kill });
    expect(kill.mock.calls).toEqual([[-77, 'SIGTERM']]);

    const noGroup = vi.fn((pid: number) => {
      if (pid < 0) throw new Error('ESRCH');
    });
    killProcessTree(77, { group: true }, { platform: 'linux', kill: noGroup });
    expect(noGroup.mock.calls).toEqual([
      [-77, 'SIGTERM'],
      [77, 'SIGTERM'],
    ]);
  });

  // Ревью 28.09 (F-144): без своей группы сигнал получал один корень — дети CLI
  // (Bash-инструменты, MCP-серверы) переживали «Остановить».
  it('POSIX без группы: потомки по снимку листьями вперёд, корень последним', () => {
    const kill = vi.fn();
    const pids = killProcessTree(
      900,
      { selfPid: -1 },
      { platform: 'linux', readTable: () => SCENE, kill },
    );
    expect(pids).toEqual([902, 904, 903, 901, 900]);
    expect(kill.mock.calls.at(-1)).toEqual([900, 'SIGTERM']);
    expect(kill.mock.calls.map(([pid]) => pid)).not.toContain(500);
  });

  it('POSIX: корень моложе spawnedAt — номер чужой, не трогаем', () => {
    const kill = vi.fn();
    const impl = { platform: 'linux', readTable: () => SCENE, kill };
    expect(killProcessTree(900, { selfPid: -1, spawnedAt: T0 }, impl)).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('разбор `ps -o etime`: дни, часы, минуты → время создания', () => {
    const now = T0 + 90_061_000;
    const rows = parsePosixProcessTable('  1     0 1-01:01:01\n 42     1    00:05\nмусор\n', now);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, created: filetimeFromMs(T0) },
      { pid: 42, ppid: 1, created: filetimeFromMs(now - 5_000) },
    ]);
  });

  // Ревью 28.09 (F-205): при таймауте разбирался обрывок вывода — корня в нём
  // могло не быть, и «root-absent» не снимал ничего.
  it('снимок с таймаутом или сбоем считается отсутствующим', () => {
    const partial = { stdout: '900 7 1\n', status: null, error: new Error('ETIMEDOUT') };
    expect(readProcessTable(() => partial)).toBeUndefined();
    expect(readPosixProcessTable(() => partial)).toBeUndefined();
    expect(readProcessTable(() => ({ stdout: '900 7 1\n', status: 1 }))).toBeUndefined();
    expect(readProcessTable(() => ({ stdout: '900 7 1\n', status: 0 }))).toEqual([
      { pid: 900, ppid: 7, created: 1n },
    ]);
  });

  it('Windows: снятие по дескриптору получает время создания из снимка; «reused» не возвращается', () => {
    const kill = vi.fn();
    const terminate = vi.fn((targets: readonly { pid: number; created: bigint | undefined }[]) => {
      const outcomes = new Map(targets.map((t) => [t.pid, 'killed' as const]));
      outcomes.set(902, 'reused' as never);
      return outcomes as never;
    });
    const killed = killProcessTree(
      900,
      { selfPid: -1 },
      { platform: 'win32', readTable: () => SCENE, kill, terminate },
    );
    expect(terminate.mock.calls[0]![0]).toContainEqual({ pid: 904, created: at(104) });
    expect(killed).not.toContain(902);
    expect(killed.at(-1)).toBe(900);
    expect(kill).not.toHaveBeenCalled();
  });

  it('Windows: помощник снятия недоступен — по номеру, как прежде', () => {
    const kill = vi.fn();
    const killed = killProcessTree(
      900,
      { selfPid: -1 },
      { platform: 'win32', readTable: () => SCENE, kill, terminate: () => undefined },
    );
    expect(killed).toHaveLength(5);
    expect(kill).toHaveBeenCalledTimes(5);
  });

  it('разбор исходов снятия: чужие строки пропускаются, пустой — снятия не было', () => {
    expect(parseKillOutcomes('#< CLIXML\r\n904 killed\r\n902 reused\r\n7 maybe\r\n')).toEqual(
      new Map([
        [904, 'killed'],
        [902, 'reused'],
      ]),
    );
    expect(parseKillOutcomes('')).toBeUndefined();
    expect(terminateByHandle([{ pid: 1, created: 0n }])).toBeUndefined();
  });

  it('негодный номер — ничего не делаем', () => {
    const kill = vi.fn();
    expect(killProcessTree(0, {}, { platform: 'win32', readTable: () => SCENE, kill })).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('killChildProcessTree — корень-дочерний', () => {
  const fake = (codes: { exitCode?: number | null; signalCode?: NodeJS.Signals | null }) => ({
    pid: 900,
    kill: vi.fn(() => true),
    ...codes,
  });

  it('вышедший дочерний по номеру не снимается: номер мог достаться другому', () => {
    const readTable = vi.fn(() => SCENE);
    const kill = vi.fn();
    const child = fake({ exitCode: 0, signalCode: null });
    expect(
      killChildProcessTree(child as never, { selfPid: -1 }, { platform: 'win32', readTable, kill }),
    ).toEqual([]);
    expect(readTable).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
  });

  it('убитый сигналом — тоже вышедший', () => {
    const readTable = vi.fn(() => SCENE);
    const child = fake({ exitCode: null, signalCode: 'SIGTERM' });
    killChildProcessTree(
      child as never,
      { selfPid: -1 },
      { platform: 'win32', readTable, kill: vi.fn() },
    );
    expect(readTable).not.toHaveBeenCalled();
  });

  it('подделка без кодов выхода по номеру не снимается (иначе тест снял бы чужой 900)', () => {
    const readTable = vi.fn(() => SCENE);
    const child = fake({});
    killChildProcessTree(
      child as never,
      { selfPid: -1 },
      { platform: 'win32', readTable, kill: vi.fn() },
    );
    expect(readTable).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
  });

  it('живой дочерний — дерево целиком, и `kill()` самому', () => {
    const kill = vi.fn();
    const child = fake({ exitCode: null, signalCode: null });
    const killed = killChildProcessTree(
      child as never,
      { selfPid: -1 },
      {
        platform: 'win32',
        readTable: () => SCENE,
        kill,
      },
    );
    expect([...killed].sort()).toEqual([900, 901, 902, 903, 904]);
    expect(child.kill).toHaveBeenCalled();
  });

  // Ревью 28.09 (F-308): у `detached`-запуска оболочка-лидер выходит, а её дети
  // держат порт. Раньше `kill(-pid)` доставал группу и так; после проверки
  // «лидер жив» снималась только оболочка — сирота оставался на порту.
  describe('POSIX: лидер группы вышел, члены живы', () => {
    const exited = () => fake({ exitCode: 0, signalCode: null });

    it('группа снимается сигналом по номеру группы', () => {
      const kill = vi.fn();
      const readGroups = () => [
        { pid: 901, pgid: 900 },
        { pid: 902, pgid: 900 },
        { pid: 1, pgid: 1 },
      ];
      const killed = killChildProcessTree(
        exited() as never,
        { group: true },
        { platform: 'linux', readGroups, kill },
      );
      expect(kill).toHaveBeenCalledWith(-900, 'SIGTERM');
      expect(killed).toEqual([901, 902]);
    });

    it('номер лидера занят живым процессом — группа чужая, не трогаем', () => {
      const kill = vi.fn();
      const readGroups = () => [
        { pid: 900, pgid: 900 },
        { pid: 901, pgid: 900 },
      ];
      killChildProcessTree(
        exited() as never,
        { group: true },
        { platform: 'linux', readGroups, kill },
      );
      expect(kill).not.toHaveBeenCalled();
    });

    it('без своей группы (не detached) и на Windows — ничего по номеру', () => {
      const kill = vi.fn();
      const readGroups = vi.fn(() => [{ pid: 901, pgid: 900 }]);
      killChildProcessTree(exited() as never, {}, { platform: 'linux', readGroups, kill });
      killChildProcessTree(
        exited() as never,
        { group: true },
        { platform: 'win32', readGroups, kill },
      );
      expect(kill).not.toHaveBeenCalled();
    });
  });
});

// Ревью 28.09 (F-206): между снимком и сигналом номер мог освободиться и
// достаться другому — `process.kill(pid)` снял бы чужого. Снятие идёт по
// ДЕСКРИПТОРУ: время создания сверяется на том же дескрипторе, которым потом
// завершается процесс. Настоящие процессы Windows; «чужой» — живой процесс,
// чьё время создания не совпадает со снимком (как у занявшего номер).
describe.runIf(process.platform === 'win32')('killProcessTree — по дескриптору (Windows)', () => {
  const sleeper = async (): Promise<import('node:child_process').ChildProcess> => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => child.once('spawn', resolve));
    return child;
  };
  const exited = (child: import('node:child_process').ChildProcess, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  it('номер из снимка занят процессом с другим временем создания — не снимаем', async () => {
    const child = await sleeper();
    try {
      const table = readProcessTable()!;
      // Снимок видел «прежних» владельцев номеров — корня и его детей (conhost
      // консольного процесса): каждый на секунду старше нынешнего.
      const tree = new Set([
        child.pid,
        ...table.filter((r) => r.ppid === child.pid).map((r) => r.pid),
      ]);
      const stale = table.map((item) =>
        tree.has(item.pid) ? { ...item, created: item.created - 10_000_000n } : item,
      );
      const killed = killProcessTree(
        child.pid!,
        { selfPid: -1 },
        { platform: 'win32', readTable: () => stale },
      );
      expect(killed).toEqual([]);
      expect(await exited(child, 1_000)).toBe(false);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('время создания совпало — снимаем', async () => {
    const child = await sleeper();
    try {
      const killed = killProcessTree(child.pid!, { selfPid: -1 });
      expect(killed.at(-1)).toBe(child.pid);
      expect(await exited(child, 5_000)).toBe(true);
    } finally {
      child.kill();
    }
  }, 30_000);
});

/**
 * Добивание пережившего команду (Ф9): дерево записано за прогон, команда вышла.
 * Наш 901 (записан) жив; его сын 905 создан после последнего снимка; 903
 * (записан) мёртв, а его сирота 906 создана после него — наша. Номер мёртвого
 * 904 занял чужой 904' позже, и его сын 907 — не наш. Сторож 500 и его дети в
 * записи не значатся и не тронуты.
 */
describe('planLeftoverKill — что пережило команду', () => {
  const known = new Map<number, bigint>([
    [900, at(100)],
    [901, at(101)],
    [903, at(103)],
    [904, at(104)],
  ]);
  const AFTER: ProcessRow[] = [
    row(4, 0, at(-1000)),
    row(500, 900, at(0)),
    row(501, 500, at(1)),
    row(901, 900, at(101)),
    row(905, 901, at(150)),
    row(906, 903, at(120)),
    row(904, 7, at(200)),
    row(907, 904, at(201)),
  ];

  it('живые записанные, их дети и сироты мёртвых записанных — листьями вперёд', () => {
    const pids = planLeftoverKill(AFTER, known, { selfPid: -1 });
    expect([...pids].sort()).toEqual([901, 905, 906]);
    expect(pids.indexOf(905)).toBeLessThan(pids.indexOf(901));
  });

  it('номер записанного занят новым процессом — ни он, ни его дети не тронуты', () => {
    const pids = planLeftoverKill(AFTER, known, { selfPid: -1 });
    expect(pids).not.toContain(904);
    expect(pids).not.toContain(907);
    expect(pids).not.toContain(500);
  });

  it('себя не снимает', () => {
    expect(planLeftoverKill(AFTER, known, { selfPid: 901 })).not.toContain(901);
  });
});

import type { ProcessRow } from '../../../lib/kill-tree.mjs';
import type { ProcessFact, ProcessFacts } from '../../../lib/peer-process/process-facts.ts';
import type { TcpRow } from '../../../lib/peer-process/peer-process.ts';
import type { GateFacts } from './human-gate.ts';

/**
 * Дерево процессов Windows для проверок ворот «только человек»: давно открытый
 * браузер с умершим родителем, панель и её запускающий, прогон модели с его
 * браузером, отвязанный помощник, браузер под Playwright, копия программы мимо
 * установки, осиротевший ребёнок, браузер в сеансе служб и в профиле из temp.
 */

export const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
  TEMP: 'C:\\Users\\owner\\AppData\\Local\\Temp',
};
export const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export const PANEL = 500;
export const LAUNCHER = 400;
export const ROOT = 700;
export const NET = 701;
export const RUN_ROOT = 800;
export const CLI = 810;
export const MODEL_BROWSER = 820;
export const MODEL_NET = 821;
export const DETACHED = 900;
export const PW_ROOT = 730;
export const PW_NET = 731;
export const COPY = 740;
export const ORPHAN = 750;
export const SERVICE = 760;
export const TEMP_ROOT = 770;
export const TEMP_NET = 771;
export const EDGE_UNDER_CHROME = 780;

export const row = (pid: number, ppid: number, created = BigInt(pid)): ProcessRow => ({
  pid,
  ppid,
  created,
});

/** Браузер давно открыт: его родитель (кто открыл) умер — номера 6666 нет. */
export const TABLE: ProcessRow[] = [
  row(1, 0, 1n),
  row(LAUNCHER, 1),
  row(PANEL, LAUNCHER),
  row(ROOT, 6666),
  row(NET, ROOT),
  row(RUN_ROOT, PANEL),
  row(CLI, RUN_ROOT),
  row(MODEL_BROWSER, CLI),
  row(MODEL_NET, MODEL_BROWSER),
  row(DETACHED, 7777),
  row(PW_ROOT, 7778),
  row(PW_NET, PW_ROOT),
  row(COPY, 7779),
  row(ORPHAN, 7780),
  row(SERVICE, 7781),
  row(TEMP_ROOT, 7782),
  row(TEMP_NET, TEMP_ROOT),
  row(EDGE_UNDER_CHROME, ROOT),
];

export const facts = (rows: readonly ProcessFact[]): ProcessFacts =>
  new Map(rows.map((fact) => [fact.pid, fact]));

export const chrome = (pid: number, args: string, session = 1, path = CHROME): ProcessFact => {
  const commandLine = `"${path}"${args ? ` ${args}` : ''}`;
  return { pid, name: 'chrome.exe', session, path, commandLine, argv: [path, ...args.split(' ')] };
};

export const NET_ARGS = '--type=utility --utility-sub-type=network.mojom.NetworkService';

export const WINDOWS = facts([
  { pid: 1, name: 'System', session: 0 },
  { pid: LAUNCHER, name: 'node.exe', session: 1 },
  { pid: PANEL, name: 'node.exe', session: 1 },
  chrome(ROOT, '--no-startup-window /prefetch:5'),
  chrome(NET, NET_ARGS),
  { pid: RUN_ROOT, name: 'claude.exe', session: 1 },
  { pid: CLI, name: 'node.exe', session: 1 },
  chrome(MODEL_BROWSER, ''),
  chrome(MODEL_NET, NET_ARGS),
  { pid: DETACHED, name: 'node.exe', session: 1 },
  chrome(PW_ROOT, '--enable-automation --remote-debugging-pipe --no-startup-window'),
  chrome(PW_NET, NET_ARGS),
  // Та же программа, скопированная мимо установки.
  chrome(COPY, '', 1, 'C:\\work\\copy\\chrome.exe'),
  // Ребёнок, чей главный процесс уже вышел.
  chrome(ORPHAN, '--type=renderer'),
  chrome(SERVICE, '', 0),
  chrome(TEMP_ROOT, '--user-data-dir=C:\\Users\\owner\\AppData\\Local\\Temp\\p1'),
  chrome(TEMP_NET, NET_ARGS),
  {
    pid: EDGE_UNDER_CHROME,
    name: 'msedge.exe',
    session: 1,
    path: EDGE,
    commandLine: `"${EDGE}"`,
    argv: [EDGE],
  },
]);

export const gate = (over: Partial<GateFacts> = {}): GateFacts => ({
  table: TABLE,
  facts: WINDOWS,
  roots: new Set([RUN_ROOT]),
  platform: 'win32',
  env: WIN_ENV,
  ...over,
});

/** Соединения: клиент (`peerPort`) → панель (5178); прокси Vite — через `hop`. */
export const request = (over: { headers?: Record<string, string>; peer?: number } = {}) => ({
  headers: (over.headers ?? {}) as Record<string, string>,
  socket: { remotePort: over.peer ?? 61_001, localPort: 5178 } as never,
});

export const deps = (
  owner: number,
  over: { rows?: TcpRow[]; known?: Set<string>; knownStand?: Set<string> } = {},
) => {
  const counter = { facts: 0 };
  return {
    counter,
    roots: () => [RUN_ROOT],
    readTable: async () => TABLE,
    readFacts: async () => {
      counter.facts += 1;
      return WINDOWS;
    },
    readTcp: async () => over.rows ?? [{ localPort: 61_001, remotePort: 5178, pid: owner }],
    ownAddresses: () => ['127.0.0.1', '100.101.9.9'],
    platform: 'win32',
    env: WIN_ENV,
    known: over.known ?? new Set<string>(),
    // Свои наборы на каждый вызов: общие на процесс тестов протекали бы между проверками.
    knownProxies: new Set<string>(),
    knownStand: over.knownStand ?? new Set<string>(),
  };
};

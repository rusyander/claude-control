import { commandSteps, gitVerb } from './check-signature.ts';
import { pipeKillTargets, type KillOwnership } from './pipe-kill.ts';
import { absolutePath, normPath, str, under } from './reduce-util.ts';
import type { WatchContext } from './watch.types.ts';

/**
 * Разбор команды оболочки для поводов сторожа: чьи процессы гасит команда (R26),
 * куда пишет вне своей копии (R31), сон в теле цикла (R11). Чистые функции над
 * текстом команды — без состояния сессии.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ─── Разбор команды оболочки ────────────────────────────────────────────────

/** Слова шага с учётом кавычек: `rm -f "a b"` → `rm`, `-f`, `a b`. */
export function words(step: string): string[] {
  const out: string[] = [];
  for (const match of step.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}

/** Шаг без служебного слова оболочки впереди: `do kill …`, `then rm …`, `sudo …`, `xargs -r kill`. */
export function bare(step: string): string {
  return step
    .replace(/^(?:(?:do|then|else|\{|\()\s+)+/, '')
    .replace(/^sudo\s+/, '')
    .replace(/^xargs(?:\s+-\S+)*\s+/, '');
}

/** Команда без комментариев оболочки: `… # sieve-ack: …` — одобренный повтор, а не другой путь. */
export function withoutComments(command: string): string {
  return command
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Сон ВНУТРИ тела цикла (между `do` и парным `done`), а не после него: `for p in …;
 * do taskkill …; done; sleep 1` — одна пауза после остановки, не опрос (C18).
 */
export function sleepInLoopBody(command: string): boolean {
  let depth = 0;
  let from = 0;
  let body = '';
  // Ключевое слово — только в начале команды (после `;`, `&`, `|`, `(`, строки): `grep -q done`
  // — слово-аргумент, не конец цикла.
  for (const match of command.matchAll(/(^\s*|[;&|(\n]\s*)(do|done)(?=[\s;&|)]|$)/g)) {
    const at = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (match[2] === 'do') {
      if (depth === 0) from = at + 2;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) body += ` ${command.slice(from, at)}`;
    }
  }
  if (depth > 0) body += ` ${command.slice(from)}`;
  return /\bsleep\s+\d/.test(body);
}

// ─── R26: остановка процессов ───────────────────────────────────────────────

const KILL_VERB = /^(?:taskkill|kill|pkill|killall|Stop-Process|fuser|(?:npx\s+)?kill-port)\b/i;
export const LOOKUP = /\b(?:netstat|lsof|Get-NetTCPConnection|ss\s+-\w*[lt])\b/i;
const PORT_NUMBER = (value: string): number | undefined => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : undefined;
};

export function isKillStep(step: string): boolean {
  const head = bare(step);
  if (!KILL_VERB.test(head)) return false;
  return !/^fuser\b/i.test(head) || /\s-\w*k/.test(head);
}

/** Порты из поиска по порту: `:5173`, `:(5173|5174)`, `-i :5173`, `-LocalPort 5173`. */
export function lookupPortsOf(command: string): number[] {
  const ports = new Set<number>();
  for (const match of command.matchAll(/:\(?((?:\d{2,5}\|)*\d{2,5})\)?/g)) {
    for (const part of (match[1] ?? '').split('|')) {
      const port = PORT_NUMBER(part);
      if (port) ports.add(port);
    }
  }
  for (const match of command.matchAll(/(?:-LocalPort|-i\s*tcp)\s*:?\s*(\d{2,5})/gi)) {
    const port = PORT_NUMBER(match[1] ?? '');
    if (port) ports.add(port);
  }
  return [...ports];
}

/**
 * Клиенты, у которых `-p`/`--port` — порт, к КОТОРОМУ подключаются: база человека, ssh,
 * redis. Их порт слушает чужой процесс, и R36 называл бы его «своим сервером, пережившим
 * паузу», а R26 — гасить его своим.
 */
const PORT_CLIENT =
  /^(?:psql|pg_dump|pg_dumpall|pg_restore|pg_isready|pgbench|mysql|mysqldump|mysqladmin|mariadb|redis-cli|valkey-cli|mongo|mongosh|mongodump|mongorestore|ssh|scp|sftp|autossh|nc|ncat|netcat|telnet|clickhouse-client|sqlcmd|cqlsh)$/i;

function clientStep(step: string): boolean {
  return words(bare(step)).some((word) =>
    PORT_CLIENT.test((word.replace(/\\/g, '/').split('/').at(-1) ?? '').replace(/\.exe$/i, '')),
  );
}

/**
 * Порты, которые команда поднимает сама: `--port 5284`, `PORT=5284`, `-p 5284`. Команда с
 * `kill` ничего не поднимает; шаг клиента (`psql -p 5432`) — тоже.
 */
export function ownPortsOf(command: string): number[] {
  const steps = commandSteps(command);
  if (steps.some(isKillStep)) return [];
  const ports = new Set<number>();
  for (const step of steps) {
    if (clientStep(step)) continue;
    for (const match of ` ${step}`.matchAll(/(?:--port[= ]|\bPORT=|\s-p\s+)(\d{4,5})\b/g)) {
      const port = PORT_NUMBER(match[1] ?? '');
      if (port) ports.add(port);
    }
  }
  return [...ports];
}

/**
 * Чужие цели остановки в команде (R26). Имя или образ (`/IM node.exe`, `pkill node`,
 * `Stop-Process -Name`) — чужие, если образец не называет свой порт; PID из поиска по
 * порту (в этой же команде или прошлом вызове) — чужие, если хоть один порт не свой;
 * `kill-port` и `fuser -k` — по своим портам. Литеральный PID без поиска — молча:
 * откуда он, не видно, а свой фоновый процесс так и гасят.
 */
export function killTargets(
  command: string,
  ownPorts: readonly number[],
  previousLookup: readonly number[] | undefined,
  own: Omit<KillOwnership, 'ports'> = { launches: [] },
): string[] {
  const piped = pipeKillTargets(command, { ...own, ports: ownPorts });
  const stepped = stepKillTargets(command, ownPorts, previousLookup);
  return [...new Set([...stepped, ...piped])];
}

/** Цели по отдельным шагам: `taskkill /IM …`, `pkill …`, `kill <PID из поиска по порту>`. */
function stepKillTargets(
  command: string,
  ownPorts: readonly number[],
  previousLookup: readonly number[] | undefined,
): string[] {
  const steps = commandSteps(command);
  const kills = steps.filter(isKillStep).map(bare);
  if (kills.length === 0) return [];
  const own = new Set(ownPorts);
  const sameLookup = steps.some((step) => LOOKUP.test(step)) ? lookupPortsOf(command) : undefined;
  const lookup = sameLookup ?? previousLookup;
  const foreignLookup = lookup?.filter((port) => !own.has(port)) ?? [];
  const namesOwnPort = (text: string): boolean =>
    [...text.matchAll(/\d{4,5}/g)].some((match) => own.has(Number(match[0])));
  const targets: string[] = [];
  for (const step of kills) {
    const args = words(step);
    const verb = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1).join(' ');
    if (verb === 'kill-port' || verb === 'npx' || verb === 'fuser') {
      const ports = [...rest.matchAll(/\d{2,5}/g)]
        .map((match) => PORT_NUMBER(match[0]))
        .filter((port): port is number => port !== undefined);
      for (const port of ports) if (!own.has(port)) targets.push(`:${port}`);
      continue;
    }
    const image = /(?:^|\s)\/{1,2}IM\s+(\S+)/i.exec(rest)?.[1] ?? /-Name\s+(\S+)/i.exec(rest)?.[1];
    const byName = verb === 'pkill' || verb === 'killall' || image !== undefined;
    if (byName) {
      const pattern =
        image ??
        args
          .slice(1)
          .filter((arg) => !arg.startsWith('-'))
          .join(' ');
      if (!namesOwnPort(pattern)) targets.push(pattern || verb);
      continue;
    }
    // `kill %1`, `kill $!` — своё фоновое задание.
    if (/%\d|\$!/.test(rest)) continue;
    if (foreignLookup.length > 0) targets.push(`PID :${foreignLookup.join(',:')}`);
  }
  return targets;
}

// ─── R31: правки вне своей копии ────────────────────────────────────────────

const GIT_WRITE_VERBS = new Set([
  'add',
  'commit',
  'checkout',
  'switch',
  'reset',
  'restore',
  'stash',
  'rm',
  'mv',
  'merge',
  'rebase',
  'pull',
  'apply',
  'cherry-pick',
  'revert',
  'clean',
  'worktree',
]);
/**
 * Перенаправление — отдельным словом (` > f`, ` 2>> f`, ` &> f`): `x=>y` и `a>b` в коде
 * `node -e "…"` — не запись (живой случай: стрелка `c=>/g…` дала «правку» в `/g`).
 */
const REDIRECT_TARGET = /(?:^|\s)(?:\d?>>?|&>)\s*("[^"]*"|'[^']*'|[^\s;|&()]+)/g;
const NOT_A_FILE = /^(?:&\d|\/dev\/null|nul)$/i;

/**
 * Знаки внутри кавычек → `_` той же длины (кавычки остаются): перенаправление ищется
 * только вне строк. Незакрытая кавычка (шаг разрезан внутри строки) маскирует хвост.
 */
function maskQuoted(step: string): string {
  let quote: string | undefined;
  let out = '';
  for (const ch of step) {
    if (quote) {
      out += ch === quote ? ch : '_';
      if (ch === quote) quote = undefined;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      out += ch;
    }
  }
  return out;
}

function redirectTargets(step: string): string[] {
  const masked = maskQuoted(step);
  const out: string[] = [];
  for (const match of masked.matchAll(REDIRECT_TARGET)) {
    const length = match[1]?.length ?? 0;
    const end = (match.index ?? 0) + match[0].length;
    const target = step.slice(end - length, end).replace(/^["']|["']$/g, '');
    if (target && !NOT_A_FILE.test(target)) out.push(target);
  }
  return out;
}

/** `S=/c/work/x; rm -rf $S` — простые присваивания той же команды подставляются. */
function variablesOf(command: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const step of commandSteps(command)) {
    const match = /^(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S+)$/.exec(bare(step));
    if (match?.[1] && match[2]) vars.set(match[1], match[2].replace(/^["']|["']$/g, ''));
  }
  return vars;
}

function expand(token: string, vars: Map<string, string>): string {
  return token.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole);
}

/** Пути, в которые пишет команда: `rm` — все, `mv`/`cp` — куда, перенаправление, `tee`, `git -C`/`cd && git`. */
function bashWrites(command: string): string[] {
  const vars = variablesOf(command);
  const out: string[] = [];
  let cdDir: string | undefined;
  for (const raw of commandSteps(command)) {
    const step = bare(raw);
    for (const target of redirectTargets(step)) out.push(expand(target, vars));
    const args = words(step.replace(REDIRECT_TARGET, ' ')).map((arg) => expand(arg, vars));
    const verb = args[0] ?? '';
    const operands = args.slice(1).filter((arg) => arg && !arg.startsWith('-'));
    if (verb === 'cd' || verb === 'pushd') cdDir = operands[0];
    else if (verb === 'rm' || verb === 'rmdir' || verb === 'tee') out.push(...operands);
    else if ((verb === 'mv' || verb === 'cp') && operands.length >= 2)
      out.push(operands.at(-1) ?? '');
    const git = gitVerb(step);
    if (git && GIT_WRITE_VERBS.has(git.verb)) {
      const dir = /^git\s+-C\s+("[^"]*"|'[^']*'|\S+)/.exec(step)?.[1]?.replace(/^["']|["']$/g, '');
      const where = dir ? expand(dir, vars) : cdDir;
      if (where) out.push(where);
    }
  }
  return out.filter(Boolean);
}

/**
 * Системные каталоги временных файлов. Только корни системы: любой сегмент `tmp`/`temp`
 * пропускал и `/work/other-repo/tmp/x` — чужую копию (F-111).
 */
const SYSTEM_TEMP =
  /^(?:\/tmp|\/var\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders|[a-z]:\/windows\/temp|[a-z]:\/users\/[^/]+\/appdata\/local\/temp)(?:\/|$)/i;

/** Временное и служебное — не копия, но и не чужое: каталог временных файлов, память CLI, `/dev/null`. */
function allowedOutside(path: string, ctx: WatchContext): boolean {
  if (SYSTEM_TEMP.test(path)) return true;
  if (NOT_A_FILE.test(path)) return true;
  const home = ctx.home ? normPath(ctx.home) : undefined;
  return home !== undefined && under(path, `${home}/.claude/projects`);
}

/**
 * Куда пишет вызов вне своей копии (R31). Bash судится только по абсолютным путям и
 * `~`: каталог оболочки сторож не знает (`cd ..` в прошлом шаге), относительный путь
 * от корня копии дал бы ложную тревогу. Без каталога звена — не судим вовсе.
 */
export function outsideWrites(
  name: string,
  input: Record<string, unknown>,
  ctx: WatchContext,
): string[] {
  if (!ctx.cwd) return [];
  const root = normPath(ctx.cwd);
  let raw: string[] = [];
  if (EDIT_TOOLS.has(name)) {
    const path = str(input.file_path) ?? str(input.notebook_path);
    raw = path ? [path] : [];
  } else if (name === 'Bash') {
    raw = bashWrites(str(input.command) ?? '').filter((path) =>
      /^(?:~|[a-zA-Z]:[\\/]|[\\/])/.test(path),
    );
  }
  const out: string[] = [];
  for (const path of raw) {
    const target = absolutePath(path, ctx);
    if (target && !under(target, root) && !allowedOutside(target, ctx)) out.push(path);
  }
  return out;
}

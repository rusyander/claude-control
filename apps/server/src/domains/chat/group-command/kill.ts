import type { Word } from './shell-parse.ts';

/**
 * Погашение процесса группой (N3, журнал 23.10 08:06:58): группа сняла
 * `taskkill` по номерам из `netstat` dev-серверы на :5173-5175 — порт стенда
 * владельца. Своё (`$!`, `%1`, процесс из своего дерева) группа гасит сама;
 * чужое и то, чьё — не доказать при решении, — человеку.
 *
 * Здесь — только разбор: что гасит звено. Чьё оно — решает маршрут прав по
 * снимку процессов (`group-permissions.ts` `withProcessFacts`).
 */

/** Цели погашения, названные числом: номера процессов и порты. */
export interface KillTargets {
  pids: number[];
  ports: number[];
}

/**
 * Итог звена погашения: `own` — только свои дети оболочки (`$!`, `%1`, проба
 * `kill -0`), `targets` — номера и порты, чьи — проверит маршрут, `unknown` —
 * цель не назвать (имя образа, шаблон, подстановка, группа процессов).
 */
export type KillVerdict =
  { kind: 'own' } | { kind: 'targets'; targets: KillTargets } | { kind: 'unknown' };

const NUMBER = /^\d{1,7}$/;
const PORT = /^\d{1,5}$/;

/** Имена команд погашения — словом команды; `.exe` и регистр Windows не в счёт. */
const KILLERS = new Set(['kill', 'taskkill', 'stop-process', 'spps', 'pkill', 'killall', 'fuser']);

function commandName(word: Word | undefined): string {
  return (word?.text ?? '').toLowerCase().replace(/\.exe$/, '');
}

const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
/** Пакеты, которые гасят процессы: `kill-port` по порту, `fkill` по имени и порту. */
const KILL_PACKAGE = /^(kill-port|fkill|fkill-cli)(@|$)/;

/**
 * Слова пакета, запущенного раннером: `npx -y kill-port 5178`, `pnpm dlx
 * kill-port`, `yarn dlx`, `npm exec`. Раньше ключи раннера (`-y`) и `dlx`
 * прятали `kill-port` (ревью 23.10, F-24). `undefined` — не раннер пакетов.
 */
function packageWords(words: Word[]): Word[] | undefined {
  const name = commandName(words[0]);
  let rest: Word[];
  if (RUNNERS.has(name)) rest = words.slice(1);
  else if (/^(pnpm|yarn|npm|bun)$/.test(name) && /^(dlx|exec|x)$/.test(words[1]?.text ?? '')) {
    rest = words.slice(2);
  } else return undefined;
  let i = 0;
  while (i < rest.length && (rest[i] as Word).text.startsWith('-')) {
    i += /^(-p|--package)$/.test((rest[i] as Word).text) ? 2 : 1;
  }
  return rest.slice(i);
}

/** Гасит ли звено процесс: `kill`, `taskkill`, `Stop-Process`, `pkill`, `npx kill-port`. */
export function isKiller(words: Word[]): boolean {
  const name = commandName(words[0]);
  const pkg = packageWords(words);
  if (pkg) return KILL_PACKAGE.test(pkg[0]?.text ?? '');
  if (name === 'kill-port' || name === 'fkill') return true;
  return KILLERS.has(name);
}

/**
 * Значение `$!` этой команды — фоновый ребёнок самой оболочки. Слово с
 * подстановкой `$!` по отдельности (`"$!"`, `${!}`) — тот же ребёнок.
 */
const CHILD = /^\$(!|\{!\})$/;

function ownChild(word: Word, childMark: string | undefined): boolean {
  if (word.literalDollar) return false;
  return CHILD.test(word.text) || (childMark !== undefined && word.text === childMark);
}

/**
 * Порты слова-цели: номер из запроса держателей порта (`$(netstat … :5173 …)`,
 * переменная с ним — `Walk.portsOf`, R-C03). Чьи держатели — проверит маршрут.
 */
export type PortsOf = (word: Word) => number[] | undefined;

/** `kill [-s SIG | -SIG | -n N | -l] цели…` в bash и coreutils. */
function killTargets(args: Word[], childMark: string | undefined, portsOf?: PortsOf): KillVerdict {
  const pids: number[] = [];
  const ports: number[] = [];
  let own = false;
  let probe = false;
  let options = true;
  // Сигнал — только ПЕРВЫЙ ключ: дальше `-1` уже цель, «все процессы
  // пользователя», а не второй сигнал (ревью 23.10, F-18: `kill -9 -1 $P`).
  let signalled = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (options && text === '--') {
      options = false;
      continue;
    }
    if (options && !signalled && /^-(l|L|-list|-table)$/.test(text)) return { kind: 'own' };
    if (options && !signalled && /^-(s|n|-signal)$/.test(text)) {
      probe ||= args[i + 1]?.text === '0';
      signalled = true;
      i += 1;
      continue;
    }
    // `kill -0 номер` — проба «жив ли», сигнала нет.
    if (options && !signalled && /^-(0|s0|-signal=0)$/.test(text)) {
      probe = true;
      signalled = true;
      continue;
    }
    if (options && !signalled && /^-([A-Za-z]+|\d{1,2}|-signal=\S+)$/.test(text)) {
      signalled = true;
      continue;
    }
    if (ownChild(arg, childMark) || /^%[\d%+-]*$/.test(text)) {
      own = true;
      continue;
    }
    const held = portsOf?.(arg);
    if (held) {
      ports.push(...held);
      continue;
    }
    // Отрицательный номер — группа процессов: её состав не проследить.
    if (arg.dynamic || !NUMBER.test(text)) return probe ? { kind: 'own' } : { kind: 'unknown' };
    pids.push(Number(text));
  }
  if (probe) return { kind: 'own' };
  if (pids.length === 0 && ports.length === 0) return own ? { kind: 'own' } : { kind: 'unknown' };
  return { kind: 'targets', targets: { pids, ports } };
}

/**
 * `taskkill /PID n [/PID m] [/T] [/F]` (и `//PID` из Git Bash, `-pid`). По
 * имени образа (`/IM node.exe`), фильтру (`/FI`) и на другой машине (`/S`) —
 * цель не назвать.
 */
function taskkillTargets(args: Word[], portsOf?: PortsOf): KillVerdict {
  const pids: number[] = [];
  const ports: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text.replace(/^\/\//, '/').toLowerCase();
    if (/^[/-](t|f)$/.test(text)) continue;
    if (/^[/-]pid$/.test(text)) {
      const value = args[i + 1];
      i += 1;
      const held = value ? portsOf?.(value) : undefined;
      if (held) {
        ports.push(...held);
        continue;
      }
      if (!value || value.dynamic || !NUMBER.test(value.text)) return { kind: 'unknown' };
      pids.push(Number(value.text));
      continue;
    }
    return { kind: 'unknown' };
  }
  return pids.length > 0 || ports.length > 0
    ? { kind: 'targets', targets: { pids, ports } }
    : { kind: 'unknown' };
}

/** `Stop-Process [-Id] n[,m] [-Force]`; по имени (`-Name`) и объектом с трубы — не назвать. */
function stopProcessTargets(args: Word[], portsOf?: PortsOf): KillVerdict {
  const pids: number[] = [];
  const ports: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text.toLowerCase();
    if (/^-(force|passthru|confirm:\$false|whatif)$/.test(text)) continue;
    const value = /^-id$/.test(text) ? args[(i += 1)] : arg;
    const held = value ? portsOf?.(value) : undefined;
    if (held) {
      ports.push(...held);
      continue;
    }
    if (!value || value.dynamic) return { kind: 'unknown' };
    const items = value.text.split(',').filter(Boolean);
    if (items.length === 0 || !items.every((item) => NUMBER.test(item))) return { kind: 'unknown' };
    pids.push(...items.map(Number));
  }
  return pids.length > 0 || ports.length > 0
    ? { kind: 'targets', targets: { pids, ports } }
    : { kind: 'unknown' };
}

/** `fuser -k 5173/tcp` гасит держателя порта; без `-k` — только печатает. */
function fuserTargets(args: Word[]): KillVerdict | undefined {
  const killing = args.some((arg) => /^-[a-zA-Z]*k[a-zA-Z]*$/.test(arg.text));
  if (!killing) return undefined;
  const ports: number[] = [];
  for (const arg of args) {
    if (arg.text.startsWith('-')) continue;
    const port = /^(\d{1,5})\/tcp$/.exec(arg.text)?.[1];
    if (arg.dynamic || !port) return { kind: 'unknown' };
    ports.push(Number(port));
  }
  return ports.length > 0 ? { kind: 'targets', targets: { pids: [], ports } } : { kind: 'unknown' };
}

/** `npx kill-port 5173 5174`, `kill-port --port 5173`. */
function killPortTargets(args: Word[]): KillVerdict {
  const ports: number[] = [];
  for (const arg of args) {
    if (/^(--port|-p|--yes|-y|--method|-m|tcp|udp)$/.test(arg.text)) continue;
    if (arg.dynamic || !PORT.test(arg.text)) return { kind: 'unknown' };
    ports.push(Number(arg.text));
  }
  return ports.length > 0 ? { kind: 'targets', targets: { pids: [], ports } } : { kind: 'unknown' };
}

/**
 * Что гасит звено (`isKiller` уже сказал «да»); `undefined` — звено ничего не
 * гасит (`fuser` без `-k`). `childMark` — значение переменной, которой в этой
 * же команде присвоили `$!` (`Walk.childMark`); `portsOf` — порты цели из
 * запроса держателей порта (`Walk.portsOf`).
 */
export function killVerdict(
  words: Word[],
  childMark?: string,
  portsOf?: PortsOf,
): KillVerdict | undefined {
  const name = commandName(words[0]);
  const args = words.slice(1);
  switch (name) {
    case 'kill':
      return killTargets(args, childMark, portsOf);
    case 'taskkill':
      return taskkillTargets(args, portsOf);
    case 'stop-process':
    case 'spps':
      return stopProcessTargets(args, portsOf);
    case 'fuser':
      return fuserTargets(args);
    case 'kill-port':
      return killPortTargets(args);
    default:
      break;
  }
  const pkg = packageWords(words);
  if (pkg && /^kill-port(@|$)/.test(pkg[0]?.text ?? '')) return killPortTargets(pkg.slice(1));
  // `pkill`, `killall`, `fkill` — по имени и шаблону: чьё попадёт под них, не доказать.
  return { kind: 'unknown' };
}

/**
 * Команда, которая гасит процесс, — словом команды, а не словом в тексте: в
 * начале строки, после `;`/`&`/`|`/`(`/`{`, внутри `$(`, после `do`/`xargs`
 * (и его ключей: `xargs -r kill`, `xargs -0 kill`). Для текста, который разбор
 * по звеньям не берёт: тело `powershell -Command "…"`, неразобранная строка;
 * его же читает ход чата (`ChatProgress.ts`), чтобы пометить погашенный порт.
 */
const KILL_COMMAND =
  /(?:^|[;&|(`\n{]|\$\(|\bdo\b|\bxargs(?:\s+-\S+)*)\s*(?:sudo\s+)?(?:taskkill|kill|pkill|killall|Stop-Process|fuser|fkill|(?:(?:npx|pnpx|bunx|(?:pnpm|yarn|npm|bun)\s+(?:dlx|exec|x))(?:\s+-\S+)*\s+)?kill-port)\b/i;

/**
 * Гасит ли команда процесс. Кавычки вырезаются (`echo "kill"` — не kill), но
 * тело `powershell -Command "…"` и `bash -c "…"` — сама команда, и в Windows
 * это обычный вид погашения (холодная проверка 29.09, N5).
 */
export function killsProcess(command: string): boolean {
  // Кавычки заменяются номерами: снаружи их текст не команда, а тело оболочки
  // потом достаётся по номеру.
  const quoted: string[] = [];
  const outer = command.replace(/"([^"]*)"|'([^']*)'/g, (_m, dq?: string, sq?: string) => {
    quoted.push(dq ?? sq ?? '');
    return `"${quoted.length - 1}"`;
  });
  if (KILL_COMMAND.test(outer)) return true;
  // Только тело оболочки, стоящей словом команды: `grep -c "kill"` — счёт
  // строк, `./check.sh` — файл, `echo "bash -c '…'"` — текст (ревью r2, R2).
  const bodies =
    /(?:^|[;&|(\n])\s*(?:sudo\s+)?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?(?=\s)[^"\n;&|]*?\s(?:-Command|-c|\/c)\s+"(\d+)"/gi;
  for (const match of outer.matchAll(bodies)) {
    if (killsProcess(quoted[Number(match[1])] ?? '')) return true;
  }
  return false;
}

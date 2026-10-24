import { normPath } from './reduce-util.ts';

/**
 * Остановка процессов через конвейер (R26, F-111): источник перечисляет процессы, сток
 * их гасит — `Get-Process node | Stop-Process`, `pgrep -f vite | xargs kill`,
 * `Get-CimInstance Win32_Process | ? {…} | % { Stop-Process … }`, `P=$(…ProcessId); for p
 * in $P; do taskkill //PID $p`, `for /f … in ('tasklist …') do taskkill`. Разбор шагов
 * (`commandSteps`) режет конвейер на куски и не видит кода внутри `powershell -Command "…"`,
 * поэтому такие формы проходили мимо R26. Чистые функции над текстом команды.
 *
 * Цель — фильтр источника: образ (`node.exe`) и образцы командной строки (`*vite*`).
 * Своя (молча) — если образец называет свой порт, файл, который эта сессия сама запустила
 * (`node .agent/tmp/L6-live.mjs` → `*L6-live.mjs*`), или свою копию; литеральный PID — тоже
 * молча, как у `kill 4242`. Образ без образца гасит все такие процессы — чужое.
 */

export interface KillOwnership {
  ports: readonly number[];
  /** Имена файлов, которые сессия запускала сама (`L6-live.mjs`), в нижнем регистре. */
  launches: readonly string[];
  /** Каталог копии: образец с её именем — свои процессы. Не у основной копии панели. */
  copy?: string;
}

interface ProcessQuery {
  image?: string;
  patterns: string[];
  ports: number[];
  ids: boolean;
}

const SOURCE =
  /^(?:Get-Process|gps|Get-CimInstance|gcim|Get-WmiObject|gwmi|ps|pgrep|pidof|tasklist(?:\.exe)?|wmic(?:\.exe)?|Get-NetTCPConnection)\b/i;
const SINK_VERB = /^(?:Stop-Process|spps|kill|taskkill(?:\.exe)?|pkill)\b/i;
const SINK_IN_BODY =
  /\b(?:Stop-Process|taskkill|kill)\b|\.Kill\(\)|Terminate\b|Invoke-CimMethod\b[^|]*Terminate/i;
const FOREACH = /^(?:ForEach-Object|foreach|%)(?:\s|\{|$)/i;
const XARGS = /^xargs\b/i;
const FILTER_VERB = /^(?:grep|egrep|fgrep|findstr(?:\.exe)?|Select-String|sls)\b/i;
const WHERE = /^(?:Where-Object|where|\?)(?:\s|\{|$)/i;
const POWERSHELL = /^(?:powershell|pwsh)(?:\.exe)?\b/i;
const CMD = /^cmd(?:\.exe)?\s+\/{1,2}c\s+/i;
const PORT = (value: string): number | undefined => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : undefined;
};

// ─── Разбор текста ──────────────────────────────────────────────────────────

/** Слова с учётом кавычек (кавычки снимаются). */
function words(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

/**
 * Режет текст по разделителям ВНЕ кавычек и скобок (`()`, `{}`): `;`, перевод строки,
 * `&&`, `||`, одиночный `&` (не `2>&1`), а с `pipes` — ещё и по одиночному `|`.
 */
function split(text: string, pipes: boolean): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '\\' && quote !== "'") {
      current += text.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '{') depth += 1;
    if ((ch === ')' || ch === '}') && depth > 0) depth -= 1;
    const two = text.slice(i, i + 2);
    const top = depth === 0;
    if (top && (two === '&&' || two === '||')) {
      if (pipes) {
        current += two;
      } else {
        out.push(current);
        current = '';
      }
      i += 1;
      continue;
    }
    const redirect = ch === '&' && (text[i - 1] === '>' || text[i + 1] === '>');
    const stepEnd = ch === ';' || ch === '\n' || (ch === '&' && !redirect);
    if (top && ((!pipes && stepEnd) || (pipes && ch === '|'))) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

/** Шаг без служебного слова впереди: `do …`, `then …`, `sudo …`, присваивание `P=…`. */
function bare(step: string): string {
  return step
    .replace(/^(?:(?:do|then|else|\{|\()\s+)+/, '')
    .replace(/^sudo\s+/, '')
    .trim();
}

/**
 * Код внутри `powershell -Command "…"` / `cmd /c "…"`: внешние кавычки сняты, экраны
 * оболочки (`\"`, `\$`, `\\`) раскрыты — так его видит сам PowerShell.
 */
function unwrapped(step: string): string | undefined {
  const head = bare(step);
  let rest: string | undefined;
  if (POWERSHELL.test(head)) {
    rest = /\s-(?:Command|c)\s+([\s\S]*)$/i.exec(head)?.[1];
  } else if (CMD.test(head)) {
    rest = head.replace(CMD, '');
  }
  if (rest === undefined) return undefined;
  const text = rest.trim();
  const outer = text[0];
  if ((outer === '"' || outer === "'") && text.endsWith(outer) && text.length > 1) {
    const inner = text.slice(1, -1);
    return outer === '"' ? inner.replace(/\\(["$\\`])/g, '$1') : inner;
  }
  return text;
}

/** Содержимое `$( … )` верхнего уровня (вложенные скобки учтены). */
function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf('$('); i >= 0; i = text.indexOf('$(', i + 2)) {
    let depth = 0;
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i + 2, j));
          break;
        }
      }
    }
  }
  return out;
}

/** `(Get-CimInstance … | ? {…}).ProcessId` → то, что в скобках; иначе текст как есть. */
function ungrouped(text: string): string {
  const value = text.trim();
  if (!value.startsWith('(')) return value;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') {
      depth -= 1;
      if (depth === 0) return value.slice(1, i);
    }
  }
  return value;
}

// ─── Что перечисляет источник ───────────────────────────────────────────────

const positional = (args: readonly string[]): string[] =>
  args.slice(1).filter((arg) => arg && !arg.startsWith('-') && !arg.startsWith('/'));

function readSource(segment: string, query: ProcessQuery): void {
  const head = bare(segment).replace(/^\(/, '');
  const args = words(head);
  const verb = (args[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if (verb === 'get-nettcpconnection') {
    for (const match of head.matchAll(/-LocalPort\s+((?:\d{2,5}\s*,\s*)*\d{2,5})/gi)) {
      for (const part of (match[1] ?? '').split(',')) {
        const port = PORT(part.trim());
        if (port) query.ports.push(port);
      }
    }
    return;
  }
  if (
    // PID числом или переменной: откуда он, не видно — молча, как `kill 4242`.
    /\s-Id\s+[\d$]/i.test(head) ||
    /\bProcessId\s*=\s*\d/i.test(head) ||
    /PID\s+eq\s+\d/i.test(head)
  ) {
    query.ids = true;
  }
  const name =
    /-Name\s+("[^"]*"|'[^']*'|[^\s|;)]+)/i.exec(head)?.[1] ??
    /\bName\s*=\s*\\?['"]([^'"\\]+)/i.exec(head)?.[1] ??
    /IMAGENAME\s+eq\s+([^\s"']+)/i.exec(head)?.[1];
  if (name) query.image = name.replace(/^["']|["']$/g, '');
  for (const match of head.matchAll(/CommandLine\s+like\s+\\?['"]([^'"\\]+)/gi)) {
    if (match[1]) query.patterns.push(match[1]);
  }
  if (verb === 'get-process' || verb === 'gps') {
    // Только первое слово после глагола: `-ErrorAction SilentlyContinue` — значение ключа, не имя.
    const first = args[1];
    if (!query.image && first && !first.startsWith('-') && !/^\d+$/.test(first)) {
      query.image = first;
    }
  } else if (verb === 'pgrep') {
    const pattern = positional(args).join(' ');
    if (pattern && args.includes('-f')) query.patterns.push(pattern);
    else if (pattern) query.image = pattern;
  } else if (verb === 'pidof') {
    const first = positional(args)[0];
    if (first) query.image = first;
  }
}

function readFilter(segment: string, query: ProcessQuery): void {
  const head = bare(segment);
  if (FILTER_VERB.test(head)) {
    const args = words(head);
    if (args.some((arg) => /^-\w*v/.test(arg) || /^\/v$/i.test(arg) || arg === '-NotMatch')) return;
    const pattern = positional(args).filter((arg) => !/^(?:-e|-E|-i|-F)$/.test(arg))[0];
    if (pattern) query.patterns.push(pattern);
    return;
  }
  if (/^awk\b/i.test(head)) {
    const pattern = /'\s*\/([^/]+)\//.exec(head)?.[1];
    if (pattern) query.patterns.push(pattern);
    return;
  }
  if (WHERE.test(head)) readWhere(head, query);
}

/** `Where-Object { $_.CommandLine -like '*x*' -and $_.Name -eq 'node.exe' }` и `? Name -eq x`. */
function readWhere(text: string, query: ProcessQuery): void {
  const clause =
    /\$_\.(\w+)\s+-(i?like|i?match|i?eq|c?like|c?match|c?eq)\s+("[^"]*"|'[^']*'|[^\s})]+)/gi;
  const short =
    /^(?:Where-Object|where|\?)\s+(\w+)\s+-(i?like|i?match|i?eq)\s+("[^"]*"|'[^']*'|\S+)/i;
  const clauses = [...text.matchAll(clause)].map((match) => [match[1], match[3]] as const);
  const one = short.exec(text);
  if (one) clauses.push([one[1], one[3]] as const);
  for (const [property, raw] of clauses) {
    const value = (raw ?? '').replace(/^["']|["']$/g, '');
    const field = (property ?? '').toLowerCase();
    if (field === 'name' || field === 'processname') query.image = value;
    else if (field === 'id' || field === 'processid') query.ids = true;
    else if (field === 'owningprocess') query.ids = true;
    else query.patterns.push(value);
  }
}

/** Конвейер гасит перечисленные процессы: источник, затем сток. Что перечислено — или ничего. */
function pipelineQuery(segments: readonly string[]): ProcessQuery | undefined {
  const from = segments.findIndex((segment) => SOURCE.test(bare(segment).replace(/^\(/, '')));
  if (from < 0) return undefined;
  const to = segments.findIndex((segment, index) => index > from && isSink(segment));
  if (to < 0) return undefined;
  const query: ProcessQuery = { patterns: [], ports: [], ids: false };
  readSource(segments[from] ?? '', query);
  for (const segment of segments.slice(from + 1, to)) readFilter(segment, query);
  return query;
}

function isSink(segment: string): boolean {
  const head = bare(segment);
  if (SINK_VERB.test(head)) return true;
  if (XARGS.test(head)) return /\b(?:kill|taskkill)\b/i.test(head);
  return FOREACH.test(head) && SINK_IN_BODY.test(head);
}

/** Источник без стока — что он перечислил бы (для `$(…)` и `for /f … in ('…')`). */
function sourceQuery(text: string): ProcessQuery | undefined {
  const segments = split(ungrouped(text), true);
  const from = segments.findIndex((segment) => SOURCE.test(bare(segment).replace(/^\(/, '')));
  if (from < 0) {
    const inner = segments.map(unwrapped).find((payload) => payload !== undefined);
    return inner === undefined ? undefined : sourceQuery(inner);
  }
  const query: ProcessQuery = { patterns: [], ports: [], ids: false };
  readSource(segments[from] ?? '', query);
  for (const segment of segments.slice(from + 1)) readFilter(segment, query);
  return query;
}

// ─── Чья цель ───────────────────────────────────────────────────────────────

const plain = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\\\./g, '.')
    .replace(/[*%^$[\]\\]/g, '');

function ownText(text: string, own: KillOwnership): boolean {
  const value = plain(text);
  if ([...value.matchAll(/\d{4,5}/g)].some((match) => own.ports.includes(Number(match[0])))) {
    return true;
  }
  for (const launch of own.launches) {
    const stem = launch.replace(/\.[^.]+$/, '');
    if (value.includes(launch) || value === stem || (stem.length >= 6 && value.includes(stem))) {
      return true;
    }
  }
  if (!own.copy) return false;
  const copy = normPath(own.copy).toLowerCase();
  const base = copy.split('/').at(-1) ?? '';
  return value.includes(copy) || (base.length >= 4 && value.includes(base));
}

/** Строка цели для сигнала или ничего, если цель своя. */
function judge(query: ProcessQuery, own: KillOwnership): string | undefined {
  if (query.ports.length > 0) {
    const foreign = query.ports.filter((port) => !own.ports.includes(port));
    return foreign.length > 0 ? `PID :${foreign.join(',:')}` : undefined;
  }
  const patterns = query.patterns.filter(Boolean);
  if (patterns.length === 0 && !query.image && query.ids) return undefined;
  if (patterns.some((pattern) => ownText(pattern, own))) return undefined;
  if (patterns.length === 0 && query.image) {
    const image = plain(query.image).replace(/\.exe$/, '');
    if (own.launches.some((launch) => launch.replace(/\.[^.]+$/, '') === image)) return undefined;
  }
  return [query.image, ...patterns].filter(Boolean).join(' ') || '*';
}

/** Шаг-сток с переменной: `taskkill //PID $p`, `kill $P`, `Stop-Process -Id $id`, `kill %a`. */
const VARIABLE_KILL =
  /^(?:kill|taskkill(?:\.exe)?|Stop-Process)\b[^|]*(?:\$(?!!)[A-Za-z_{(]|%%?\w)/i;

/**
 * Чужие цели остановки, которые видны только целым конвейером, кодом PowerShell или
 * подстановкой. Возвращает строки целей (повтор одной цели — один раз).
 */
export function pipeKillTargets(command: string, own: KillOwnership, nesting = 0): string[] {
  if (nesting > 3) return [];
  const targets = new Set<string>();
  const add = (query: ProcessQuery | undefined): void => {
    const target = query ? judge(query, own) : undefined;
    if (target) targets.add(target);
  };
  const steps = split(command, false);
  const variableKill = steps.some((step) =>
    split(step, true).some((segment) => VARIABLE_KILL.test(bare(segment))),
  );
  for (const step of steps) {
    const forLoop = /^for\s+\/f\b[^(]*\(\s*['"`]([^'"`]*)['"`]\s*\)\s*do\s+(.*)$/i.exec(bare(step));
    if (forLoop && SINK_IN_BODY.test(forLoop[2] ?? '')) {
      add(sourceQuery((forLoop[1] ?? '').replace(/\^\|/g, '|')));
      continue;
    }
    // `(Get-Process node).Kill()` — источник и сток в одном выражении.
    if (/^\([\s\S]*\)\s*\.Kill\(\)/i.test(bare(step))) {
      add(sourceQuery(bare(step)));
      continue;
    }
    const segments = split(step, true);
    for (const segment of segments) {
      const payload = unwrapped(segment);
      if (payload !== undefined) {
        for (const target of pipeKillTargets(payload, own, nesting + 1)) targets.add(target);
      }
    }
    add(pipelineQuery(segments));
  }
  // `P=$(… ProcessId); for p in $P; do taskkill //PID $p` и `kill $(pgrep -f vite)`.
  if (variableKill) {
    for (const inner of substitutions(command)) add(sourceQuery(inner));
  }
  return [...targets];
}

/**
 * Файлы, которые команда запускает сама (`node .agent/tmp/L6-live.mjs`, `python x.py`,
 * `./tool.exe`): их остановка по образцу — своя. Только имя файла, нижний регистр.
 */
export function launchesOf(command: string): string[] {
  const out = new Set<string>();
  const runner =
    /^(?:node|nodejs|tsx|ts-node|deno|bun|python3?|py|bash|sh|pwsh|powershell|nohup|setsid|start|exec|npx)(?:\.exe)?$/i;
  for (const step of split(command, false)) {
    for (const segment of split(step, true)) {
      const args = words(bare(segment).replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ''));
      const head = args[0] ?? '';
      const script = /[\w.-]+\.(?:mjs|cjs|js|ts|mts|py|sh|ps1|exe)$/i;
      if (!runner.test(head) && !script.test(head)) continue;
      for (const arg of args) {
        const name = arg.replace(/\\/g, '/').split('/').at(-1) ?? '';
        if (script.test(name) && !runner.test(name)) out.add(name.toLowerCase());
      }
    }
  }
  return [...out];
}

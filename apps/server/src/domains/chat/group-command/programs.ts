import { runsInput } from './readers.ts';
import type { Word } from './shell-parse.ts';
import { targetKind } from './targets.ts';
import { DANGER, OTHER, ROUTINE, type SegmentVerdict, type Walk } from './walk.ts';
import { editLandsUnseen, spoils, writeKind } from './writes.ts';

/**
 * `sed` и `awk`, которые не только печатают. Раньше такие звенья шли в разбор
 * «незнакомой обёртки», и тот принимал сценарий `s/\r\?$//` или текст
 * `print "$1"` за команду оболочки — карточка на обычной правке файла
 * (ревью 23.10, зона A). Здесь сценарий читается как сценарий: исполнение
 * (`e`, `s///e`, `system()`, `| "cmd"`) судится как команда, запись (`w файл`,
 * `print > "файл"`, `-i`) — как запись файла.
 */

/** Сценарий исполнит команду: известный текст судит вызывающий. */
export type RunScript = (script: string) => SegmentVerdict;

interface Facts {
  runs: string[];
  /** Исполнится то, что окажется в буфере (`e` без текста, `s///e`): не прочесть. */
  runsUnknown: boolean;
  writes: string[];
  ok: boolean;
}

const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|/(?:[^/\\]|\\.)*/[IM]*)`;
const SED_RANGE = new RegExp(
  String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?\s*!?)?\s*`,
);

function restOfLine(script: string, from: number): { text: string; end: number } {
  const newline = script.indexOf('\n', from);
  const end = newline < 0 ? script.length : newline;
  return { text: script.slice(from, end).trim(), end };
}

/** Конец `s/…/…/` или `y/…/…/`; `-1` — не разобрать. */
function substitutionEnd(script: string, from: number): number {
  const delimiter = script[from];
  if (!delimiter || /[\s\\]/.test(delimiter)) return -1;
  let fields = 0;
  let i = from + 1;
  for (; i < script.length && fields < 2; i += 1) {
    if (script[i] === '\\') i += 1;
    else if (script[i] === delimiter) fields += 1;
  }
  return fields < 2 ? -1 : i;
}

/** Одна команда `sed` с позиции `i`; возвращает позицию после неё или `-1`. */
function sedCommand(script: string, at: number, facts: Facts): number {
  const command = script[at];
  let i = at + 1;
  if (command === undefined) return i;
  if ('{}pPdDnNgGhHxzF='.includes(command)) return i;
  if ('qQlL'.includes(command)) return i + (/^\s*\d*/.exec(script.slice(i))?.[0].length ?? 0);
  if ('btT:'.includes(command)) return i + (/^[^;\n]*/.exec(script.slice(i))?.[0].length ?? 0);
  if ('aicrR'.includes(command)) return restOfLine(script, i).end;
  if (command === 'w' || command === 'W' || command === 'e') {
    const { text, end } = restOfLine(script, i);
    if (command !== 'e') facts.writes.push(text);
    else if (text) facts.runs.push(text);
    else facts.runsUnknown = true;
    return end;
  }
  if (command !== 's' && command !== 'y') return -1;
  i = substitutionEnd(script, i);
  if (i < 0 || command === 'y') return i;
  const flags = /^[gpiImMe\d]*/.exec(script.slice(i))?.[0] ?? '';
  if (flags.includes('e')) facts.runsUnknown = true;
  i += flags.length;
  if (script[i] !== 'w') return i;
  const { text, end } = restOfLine(script, i + 1);
  facts.writes.push(text);
  return end;
}

function readSed(script: string, facts: Facts): void {
  let i = 0;
  while (i < script.length && facts.ok) {
    const gap = /^[\s;]+/.exec(script.slice(i));
    if (gap) {
      i += gap[0].length;
      continue;
    }
    i += SED_RANGE.exec(script.slice(i))?.[0].length ?? 0;
    const next = sedCommand(script, i, facts);
    if (next < 0) facts.ok = false;
    else i = next;
  }
}

/** Ключи `sed`, у которых нет своего значения: печать, режимы разбора. */
const SED_FLAGS =
  /^-[nErsuz]+$|^--(quiet|silent|regexp-extended|unbuffered|null-data|separate|posix|debug|sandbox|follow-symlinks)$/;

interface SedArgs {
  scripts: Word[];
  files: Word[];
  inPlace: boolean;
  /** Сценарий из файла (`-f`) или ключ, которого здесь не знают. */
  opaque: boolean;
}

function sedArgs(args: Word[]): SedArgs {
  const parsed: SedArgs = { scripts: [], files: [], inPlace: false, opaque: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (/^-[nErsuz]*i/.test(text) || /^--in-place(=|$)/.test(text)) parsed.inPlace = true;
    else if (/^-[nErsuz]*e$/.test(text) || text === '--expression') {
      const script = args[i + 1];
      if (script) parsed.scripts.push(script);
      else parsed.opaque = true;
      i += 1;
    } else if (text.startsWith('--expression=')) {
      parsed.scripts.push({ ...arg, text: text.slice('--expression='.length) });
    } else if (text === '-l' || text === '--line-length') i += 1;
    else if (SED_FLAGS.test(text) || /^--line-length=/.test(text)) continue;
    else if (text.startsWith('-') && text !== '-') parsed.opaque = true;
    else parsed.files.push(arg);
  }
  if (parsed.scripts.length === 0 && !parsed.opaque) {
    const script = parsed.files.shift();
    if (script) parsed.scripts.push(script);
  }
  return parsed;
}

/**
 * Файл, который сценарий запишет: невозвратное (`writes.ts`) — человеку, во
 * временное — сам, своё в копии — сам с записью, прочее — правила чата.
 * `edit` — правка на месте (`-i`): это правка файла, а не его уничтожение, и
 * место само по себе карточкой её не делает (политика владельца 19.10).
 */
function writeVerdict(file: Word, walk: Walk, edit = false): SegmentVerdict {
  if (!file.dynamic && /^\/dev\/(stdout|stderr|null)$/.test(file.text)) return ROUTINE;
  if (edit ? editLandsUnseen(file, walk) : spoils(file, walk, 'config')) return DANGER;
  if (writeKind(file, walk) === 'temp') return ROUTINE;
  return targetKind(file, walk, { ...walk.place(), write: true }) === 'own'
    ? { kind: 'routine', writes: true }
    : OTHER;
}

/** Худший из приговоров: человек > правила чата > сам. */
function worst(verdicts: SegmentVerdict[]): SegmentVerdict {
  let result: SegmentVerdict = ROUTINE;
  for (const verdict of verdicts) {
    if (verdict.kind === 'danger') return DANGER;
    if (verdict.kind === 'other') result = OTHER;
    else if (result.kind === 'routine' && verdict.writes) result = verdict;
  }
  return result;
}

function factsVerdict(facts: Facts, walk: Walk, run: RunScript): SegmentVerdict {
  if (facts.runsUnknown) return DANGER;
  // Команда сценария судится как своя: её последствия ложатся в общий итог.
  const runs = facts.runs.map((script) => run(script));
  const writes = facts.writes.map((file) => writeVerdict({ text: file, dynamic: false }, walk));
  return worst([...runs, ...writes]);
}

/** `sed -i 's/a/b/' файл`, `sed 's/x/y/w out'`, `sed '1e date'`. */
export function sedVerdict(words: Word[], walk: Walk, run: RunScript): SegmentVerdict {
  const args = sedArgs(words.slice(1));
  const files = args.inPlace ? args.files.map((file) => writeVerdict(file, walk, true)) : [];
  if (files.some((verdict) => verdict.kind === 'danger')) return DANGER;
  if (args.opaque || args.scripts.some((script) => script.dynamic)) return OTHER;
  const facts: Facts = { runs: [], runsUnknown: false, writes: [], ok: true };
  for (const script of args.scripts) readSed(script.text, facts);
  if (!facts.ok) return worst([...files, OTHER]);
  return worst([...files, factsVerdict(facts, walk, run)]);
}

/**
 * Строки awk в кавычках — в `system("…")`, `| "…"`, `"…" | getline`, `> "…"`.
 * Ищутся по остову программы, где каждая строка заменена меткой `N`:
 * `|` и `>` внутри строки (`print $2 "|" $3`) — буквы, а не труба и запись.
 */
const AWK_SYSTEM = /\bsystem\s*\(\s*(\d+)\s*\)/g;
const AWK_PIPE_TO = /\|\s*(\d+)/g;
const AWK_PIPE_FROM = /(\d+)\s*\|\s*getline/g;
const AWK_OUTPUT = /(?<![<>=!])>>?\s*(\d+)/g;
/**
 * Исполнение из выражения, а не из строки (`system($0)`, `print | cmd`,
 * `cmd | getline`), сопроцесс `|&`, подгрузка `@load`/`@include`: что
 * исполнится, не прочесть — как `eval "$x"`. `||` — логика, не труба.
 */
const AWK_RUNS_OPAQUE =
  /\bsystem\s*\(\s*[^\s)]|(?<!\|)\|(?![|&])\s*(?!getline\b)[^\s]|(?<!\s*)(?<!\|)\|\s*getline\b|\|&|@include|@load/;
/** Запись из выражения: `print > out` и сравнение `$3 > x` по тексту не отличить. */
const AWK_WRITES_OPAQUE = />>?\s*[A-Za-z_$(]/;
/** Регулярное выражение awk (`/a|b/`): `|` в нём — не труба. После знака или начала. */
const AWK_REGEX = /(?<=(?:^|[(,~!{};&|\n])\s*)\/(?:[^/\\\n]|\\.)+\//g;

/** Остов программы и её строки (без кавычек, `\x` раскрыты). */
function awkSkeleton(program: string): { skeleton: string; literals: string[] } {
  const literals: string[] = [];
  const skeleton = program
    .replace(/"((?:[^"\\]|\\.)*)"/g, (_match, body: string) => {
      literals.push(body.replace(/\\(.)/g, '$1'));
      return `${literals.length - 1}`;
    })
    .replace(AWK_REGEX, '');
  return { skeleton, literals };
}

const strings = (skeleton: string, literals: string[], pattern: RegExp): string[] =>
  [...skeleton.matchAll(pattern)].map((match) => literals[Number(match[1])] as string);

/** Программа `awk`: первое слово без ключа; `-f` — программа из файла. */
function awkProgram(args: Word[]): Word | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (text === '-F' || text === '-v') i += 1;
    else if (/^-(F|v)\S/.test(text)) continue;
    else if (text === '--') return args[i + 1];
    else if (text.startsWith('-')) return undefined;
    else return args[i];
  }
  return undefined;
}

/** `awk '{ system("rm -rf ~") }'`, `awk '{ print > "/etc/x" }'`. */
export function awkVerdict(words: Word[], walk: Walk, run: RunScript): SegmentVerdict {
  const args = words.slice(1);
  // `gawk -i inplace` правит файлы на месте, как `sed -i` (`writeVerdict`).
  const edits = args.some((arg) => /^(-i|--include)(=|$)|^-i\S/.test(arg.text));
  if (edits && args.some((arg) => editLandsUnseen(arg, walk))) return DANGER;
  const program = awkProgram(args);
  if (!program || program.dynamic) return OTHER;
  const { skeleton, literals } = awkSkeleton(program.text);
  const runs = [AWK_SYSTEM, AWK_PIPE_TO, AWK_PIPE_FROM].flatMap((pattern) =>
    strings(skeleton, literals, pattern),
  );
  const writes = strings(skeleton, literals, AWK_OUTPUT);
  // `print … | "sh"`: оболочка исполнит напечатанное программой — его не прочесть.
  const feedsShell = strings(skeleton, literals, AWK_PIPE_TO).some((text) =>
    runsInput(
      text
        .trim()
        .split(/\s+/)
        .map((word): Word => ({ text: word, dynamic: false })),
    ),
  );
  const runsUnknown = feedsShell || AWK_RUNS_OPAQUE.test(skeleton);
  const facts: Facts = { runs, runsUnknown, writes, ok: true };
  const verdict = factsVerdict(facts, walk, run);
  if (verdict.kind === 'danger') return verdict;
  return AWK_WRITES_OPAQUE.test(skeleton) ? OTHER : verdict;
}

export function isProgram(name: string): boolean {
  return name === 'sed' || name === 'awk' || name === 'gawk' || name === 'mawk';
}

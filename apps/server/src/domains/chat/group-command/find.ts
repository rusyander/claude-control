import { isTempPattern, resolveFrom } from './paths.ts';
import type { Word } from './shell-parse.ts';
import { pathsVerdict } from './targets.ts';
import { DANGER, OTHER, ROUTINE, isAbsolute, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * `find`: откуда ищет, что удаляет, что исполняет на найденном. Ревью 23.10
 * (F-09…F-11): `-execdir` судился из каталога звена, а исполняется в каталоге
 * каждой находки; фильтр «только временное» снимал проверку мест поиска
 * (`find / -name "*.log" -delete`); первый `+` кончал `-exec` (`-exec rm -rf + {} +`);
 * `{}` внутри слова (`{}/`) не подставлялся; `-empty` считался временным.
 */
export interface FindPlan {
  starts: Word[];
  deletes: boolean;
  /** `-exec`/`-execdir`/`-ok`: команды на найденном; `dir` — в каталоге находки. */
  execs: { words: Word[]; dir: boolean }[];
  /** `-fprint`, `-fls` — запись в файл. */
  writes: boolean;
  /**
   * Фильтр пропускает только временное: `-name '*.log'`, `-name __pycache__`,
   * пустые каталоги (`-type d -empty`). Места поиска это не снимает.
   */
  tempOnly: boolean;
}

const FIND_WRITES = /^-(fprint0?|fprintf|fls)$/;
const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;
const FIND_NAME = /^-(name|iname)$/;
/** Ключи до мест поиска: `-H`, `-L`, `-P`, `-D отладка`, `-O3`. */
const FIND_LEADING = /^-([HLP]|O\d*)$/;

/** Конец `-exec`: `;` всегда, `+` — только сразу после `{}`. */
function execEnd(args: Word[], from: number): number {
  for (let j = from; j < args.length; j += 1) {
    const text = (args[j] as Word).text;
    if (text === ';' || text === '\\;') return j;
    if (text === '+' && args[j - 1]?.text === '{}' && j - 1 >= from) return j;
  }
  return -1;
}

export function findPlan(args: Word[]): FindPlan | undefined {
  let i = 0;
  while (i < args.length) {
    const text = (args[i] as Word).text;
    if (text === '-D') i += 2;
    else if (FIND_LEADING.test(text)) i += 1;
    else break;
  }
  const starts: Word[] = [];
  while (i < args.length && !/^[-(!)]|^\\\(/.test((args[i] as Word).text)) {
    starts.push(args[i++] as Word);
  }
  const plan: FindPlan = {
    starts: starts.length > 0 ? starts : [{ text: '.', dynamic: false }],
    deletes: false,
    execs: [],
    writes: false,
    tempOnly: false,
  };
  let names = 0;
  let tempNames = 0;
  let branching = false;
  let empty = false;
  let dirsOnly = false;
  for (; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (text === '-delete') plan.deletes = true;
    else if (FIND_WRITES.test(text)) plan.writes = true;
    else if (/^(-o|-or|!|-not|\(|\\\(|,)$/.test(text)) branching = true;
    else if (text === '-empty') empty = true;
    else if (text === '-type') {
      dirsOnly = args[i + 1]?.text === 'd';
      i += 1;
    } else if (FIND_NAME.test(text)) {
      names += 1;
      const pattern = args[i + 1];
      if (pattern && !pattern.dynamic && isTempPattern(pattern.text)) tempNames += 1;
      i += 1;
    } else if (FIND_EXEC.test(text)) {
      const end = execEnd(args, i + 1);
      if (end < 0) return undefined;
      plan.execs.push({ words: args.slice(i + 1, end), dir: /dir$/.test(text) });
      i = end;
    }
  }
  // Пустой каталог удалить нечего; пустой файл (`.gitkeep`, `__init__.py`) — уже работа.
  plan.tempOnly = ((names > 0 && names === tempNames) || (empty && dirsOnly)) && !branching;
  return plan;
}

/** Место поиска своё: в копии, свежий `mktemp`, своя рабочая папка CLI. */
function ownStart(start: Word, walk: Walk): boolean {
  const word = walk.expand(start);
  if (word.dynamic) return false;
  const cwd = walk.cwd ?? (isAbsolute(word.text) ? '/' : undefined);
  if (!cwd) return false;
  const path = resolveFrom(cwd, word.text);
  return walk.inCopy(path) || walk.isFresh(path) || walk.inOwnScratchpad(path);
}

/** `{}` в слове команды `-exec` — найденный путь: свежая метка обхода или неизвестное. */
function substitute(word: Word, found: string | undefined): Word {
  if (!word.text.includes('{}')) return word;
  // Неизвестная находка — подстановка, которую обход не раскроет: голое `{}`
  // с `dynamic` он счёл бы буквальным относительным путём.
  if (found === undefined) return { text: word.text.replaceAll('{}', '$(find)'), dynamic: true };
  return { text: word.text.replaceAll('{}', found), dynamic: word.dynamic };
}

/**
 * Итог `find`: команды `-exec` судятся как звенья (`command`), `-delete` — по
 * местам поиска, если фильтр не доказал, что находки только временные в своих
 * местах.
 */
export function findVerdict(
  find: FindPlan,
  walk: Walk,
  command: (words: Word[]) => SegmentVerdict,
): SegmentVerdict {
  if (find.writes) return OTHER;
  const tempOnly = find.tempOnly && find.starts.every((start) => ownStart(start, walk));
  // Находка временного — свежий путь обхода: его не написать руками.
  const found = tempOnly ? walk.freshPath('file') : undefined;
  let deletes = false;
  for (const exec of find.execs) {
    const inner = exec.words.map((word) => substitute(word, found));
    // `-execdir` исполняет в каталоге каждой находки: относительное — неизвестно где.
    if (exec.dir) {
      walk.enter();
      walk.cwd = undefined;
      walk.anchored = false;
    }
    const verdict = command(inner);
    if (exec.dir) walk.leave();
    if (verdict.kind !== 'routine') return verdict;
    deletes ||= verdict.deletes === true;
  }
  if (find.deletes && !tempOnly && !pathsVerdict(find.starts, walk, walk.place())) return DANGER;
  return deletes || find.deletes ? { kind: 'routine', deletes: true } : ROUTINE;
}

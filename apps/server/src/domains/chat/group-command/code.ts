import type { InterpreterCode } from './interpreters.ts';
import { codeRules, dbDanger, riskyCode, type CodeRule } from './risky.ts';
import type { Word } from './shell-parse.ts';
import { targetKind } from './targets.ts';
import { DANGER, OTHER, type SegmentVerdict, type Walk } from './walk.ts';
import { editLandsUnseen, spoils } from './writes.ts';

/**
 * Код интерпретатора: снос, пуш, слияние — человеку; запись в базу — правилам
 * чата. Удаление файлов судится по ЦЕЛИ, как `rm` (ревью 23.10, F-08): раньше
 * `python -c "shutil.rmtree('/etc')"` шёл строкой «удаление файлов» и проходил
 * сам, когда `rm -rf /etc` поднимал карточку.
 */

/** Код гасит процесс по номеру: `process.kill(pid)`, `os.kill(pid, …)`. */
const CODE_KILL = /\b(?:process|os)\s*\.\s*kill(?:pg)?\s*\(/;

/**
 * Вызовы удаления в коде. Альтернативы в одном выражении: `os.rmdir` берётся
 * один раз, а не ещё и как `.rmdir`.
 */
const DELETE_NAME =
  /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\b|\b(?:fs|fsp|promises)\s*\.\s*(?:rm|unlink|rmdir)\b|\bFileUtils\s*\.\s*(?:rm\w*|remove\w*)\b|\bFile\s*\.\s*delete\b|\b(?:shutil\s*\.\s*)?rmtree\b|\b(?:rmSync|rmdirSync|unlinkSync|rimraf(?:Sync)?)\b|\.\s*(?:unlink|rmdir)\b|\b(?:unlink|rmdir)\b/g;
/** `Path('x').unlink()` — цель в получателе вызова. */
const PATH_RECEIVER = /Path\(\s*(['"])([^'"\\]*)\1\s*\)\s*$/;
/** Строка кода — команда удаления оболочки: `os.system('rm -rf …')`, `['rm', '-rf', x]`. */
const REMOVER_STRING =
  /(['"`])\s*(?:sudo\s+)?(rm|rmdir|rd|del|erase|unlink|shred|rimraf|trash|Remove-Item)(?=\s|\1)/i;

/**
 * Путь одним литералом через `path.resolve('x')` / `require('path').join('x')`
 * — тот же `x` от каталога процесса (живая карточка N4, 23.10).
 */
const PATH_CALL =
  /^\s*(?:require\(\s*(['"])(?:node:)?path\1\s*\)|path)\s*\.\s*(?:resolve|join|normalize)\(\s*(['"`])([^'"`\\]*)\2\s*\)/;

/** Литерал в начале `text` (после пробелов): `'x'`, `"x"`, `` `x` `` без подстановок. */
function literalAt(text: string): string | undefined {
  const call = PATH_CALL.exec(text);
  if (call) return call[2] === '`' && (call[3] ?? '').includes('${') ? undefined : call[3];
  const match = /^\s*(['"`])([^'"`\\]*)\1/.exec(text);
  if (!match || (match[1] === '`' && (match[2] ?? '').includes('${'))) return undefined;
  return match[2];
}

/**
 * Цели удаления в коде: литерал каждого вызова; `undefined` — хоть одну цель не
 * прочесть (переменная, ссылка на функцию без вызова, `Path(x).unlink()`).
 */
function deleteTargets(code: string): string[] | undefined {
  const targets: string[] = [];
  for (const match of code.matchAll(DELETE_NAME)) {
    const end = (match.index ?? 0) + match[0].length;
    const after = code.slice(end);
    if (!/^\s*\(/.test(after)) return undefined;
    const argument = after.replace(/^\s*\(/, '');
    let target = literalAt(argument);
    if (target === undefined && match[0].startsWith('.') && /^\s*\)/.test(argument)) {
      target = PATH_RECEIVER.exec(code.slice(0, match.index))?.[2];
    }
    if (target === undefined) return undefined;
    targets.push(target);
  }
  return targets;
}

/** Удаление в коде задевает то, что решает человек. */
function deletesProtected(code: string, walk: Walk): boolean {
  if (REMOVER_STRING.test(code)) return true;
  const targets = deleteTargets(code);
  if (!targets) return true;
  const place = walk.place();
  return targets.some((text) => {
    // `~`, `$HOME`, `%TEMP%` в строке кода раскроет уже сама программа.
    const word: Word = { text, dynamic: /^~|[$%]/.test(text) };
    return targetKind(word, walk, place) === 'protected';
  });
}

/** Запись файла в коде: `fs.writeFileSync('x', …)`, `appendFile`, `createWriteStream`. */
const WRITE_CALL = /\b(writeFileSync|writeFile|createWriteStream|appendFileSync|appendFile)\s*\(/g;
/** `open('x', 'w')` Python: режим записи, дозаписи или создания. */
const PY_OPEN = /\bopen\s*\(\s*(['"])([^'"\\]*)\1\s*,\s*(?:mode\s*=\s*)?(['"])([^'"]*)\3/g;
/** `Path('x').write_text(…)`. */
const PATH_WRITE = /Path\(\s*(['"])([^'"\\]*)\1\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/g;

/**
 * Запись литералом в настройки дома и систему (R-C05, ревью корпуса 23.10):
 * `node -e "fs.writeFileSync('~/.bashrc', …)"` — как `> ~/.bashrc`. Цель —
 * переменная — не судится: запись в коде, как и раньше, обычная работа.
 */
function writesProtected(code: string, walk: Walk): boolean {
  const targets: { text: string; append: boolean }[] = [];
  for (const match of code.matchAll(WRITE_CALL)) {
    const text = literalAt(code.slice((match.index ?? 0) + match[0].length));
    if (text !== undefined) targets.push({ text, append: (match[1] ?? '').startsWith('append') });
  }
  for (const match of code.matchAll(PY_OPEN)) {
    const mode = match[4] ?? '';
    if (/[wax+]/.test(mode)) targets.push({ text: match[2] ?? '', append: !/[wx+]/.test(mode) });
  }
  for (const match of code.matchAll(PATH_WRITE)) {
    targets.push({ text: match[2] ?? '', append: false });
  }
  return targets.some(({ text, append }) =>
    spoils({ text, dynamic: /^~|[$%]/.test(text) }, walk, append ? 'append' : 'config'),
  );
}

export function codeVerdict(
  code: InterpreterCode | undefined,
  words: Word[],
  walk: Walk,
): SegmentVerdict {
  // Файл в хранилище git словом программы (`perl -pi -e … .git/config`): правка
  // на месте или сценарий над ним уводит пуш — как `sed -i` (`editLandsUnseen`).
  // Сам код — не путь (`-e "require('C:/r/.git/x.json')"` читает): его судит разбор ниже.
  const codes = new Set(code?.codes ?? []);
  const files = words.slice(1).filter((word) => !codes.has(word.text));
  if (files.some((word) => editLandsUnseen(word, walk))) return DANGER;
  // Сценарий из файла: его не прочесть, но `manage.py flush` и `db:drop` видны в словах.
  if (!code || code.codes.length === 0) return dbDanger(words) ? DANGER : OTHER;
  const rules = new Set<CodeRule>();
  for (const text of code.codes) {
    if (riskyCode(text) || CODE_KILL.test(text) || deletesProtected(text, walk)) return DANGER;
    if (writesProtected(text, walk)) return DANGER;
    for (const rule of codeRules(text)) rules.add(rule);
  }
  // Рядом с кодом подгружен файл или модуль (`node -r ./x.js -e 1`): его не
  // прочесть — звено как `node x.js`, правила чата судят его слова.
  if (code.file) return { kind: 'other', rules: [...rules] };
  return { kind: 'other', checked: true, rules: [...rules] };
}

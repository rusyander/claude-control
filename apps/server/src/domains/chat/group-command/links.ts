import { within } from './paths.ts';
import type { Word } from './shell-parse.ts';

/**
 * Ссылки, которые заводит эта же команда (RF-BGCD-04). Путь ниже такой ссылки
 * ведёт туда, куда она смотрит, а на диске её ещё нет — настоящий путь не
 * сверить: `d=$(mktemp -d) && cmd //c mklink //J "$d\l" C:\work && rm -rf
 * "$d/l/"*` сносил файлы `C:\work` как уборку временного. Путь ниже ссылки этой
 * команды не временный, не пробный репозиторий и не своя копия. Ссылку, чей
 * путь не проследить, считаем лежащей где угодно: дальше временного нет вовсе.
 */
export class LinkLedger {
  private readonly made: string[] = [];
  /** Каталоги, куда эта команда распаковала архив (`extract.ts`). */
  private readonly unpacked: string[] = [];
  private unknown = false;

  /** Путь заведённой ссылки (как его судит обход); `undefined` — путь не проследить. */
  note(path: string | undefined): void {
    if (path === undefined) this.unknown = true;
    else this.made.push(path);
  }

  /**
   * Каталог распаковки: в архиве могут лежать ссылки, а на диске их до запуска
   * нет — живой проверке нечего сверить. Неизвестный каталог — как ссылка где угодно.
   */
  noteUnpacked(path: string | undefined): void {
    if (path === undefined) this.unknown = true;
    else this.unpacked.push(path);
  }

  /** Эта команда уже заводила ссылки (или распаковывала архив). */
  get any(): boolean {
    return this.unknown || this.made.length > 0 || this.unpacked.length > 0;
  }

  /**
   * Путь идёт через ссылку этой команды: ниже неё — всегда, в неё саму — когда
   * действие идёт по ссылке (`follow`: запись, `rm -rf l/`, `cd l`). Ниже
   * каталога распаковки — когда путь проходит СКВОЗЬ имя из архива: `D/x/`,
   * `D/x/*`, `D/*`, запись в `D/x`; `rm -rf D` и `rm -rf D/x` ссылку не открывают.
   */
  crosses(path: string, follow: boolean): boolean {
    if (this.unknown) return true;
    if (this.unpacked.some((root) => traverses(path, root, follow))) return true;
    return this.made.some((link) => (path === link ? follow : within(path, link)));
  }
}

/** Путь ниже `root` идёт сквозь его содержимое: шаблон, вложенное имя или само имя по ссылке. */
function traverses(path: string, root: string, follow: boolean): boolean {
  if (path === root || !within(path, root)) return false;
  const parts = path.slice(root.replace(/\/$/, '').length + 1).split('/');
  return follow || parts.length > 1 || parts.some((part) => /[*?[]/.test(part));
}

/** Ключи `ln`/`cp` со значением отдельным словом. */
const VALUED = /^(-t|-S|--target-directory|--suffix)$/;
/** Ключи `cp`, после которых он заводит ссылки вместо копий. */
const CP_LINKS = /^(--symbolic-link|--link|-[a-zA-Z]*[sl][a-zA-Z]*)$/;
/** Тип элемента PowerShell — ссылка: `New-Item -ItemType Junction`. */
const PS_LINK = /\b(SymbolicLink|Junction|HardLink)\b/i;
/** `mklink` словом внутри строки `cmd`. */
const MKLINK = /(^|[\s"'&|;(])mklink(\.exe)?(?=[\s"']|$)/i;

/** Ключи самого `cmd` до команды (`/d`, `/s`, `/q`, `/c`); `//c` — так его пишут из Git Bash. */
const CMD_SWITCH = /^\/\/?[a-z](:(on|off))?$/i;
/** Ключ `mklink` одной буквой: `/J`, `//J`, `/D`, `/H`. */
const MKLINK_SWITCH = /^\/\/?[a-z]$/i;
/** Ссылка каталога: точка соединения (`/J`) или символьная ссылка (`/D`). */
const MKLINK_DIR = /^\/\/?[jd]$/i;
/** `$(cygpath -w путь)` — тот же путь в другом написании; в пути — слова и `$ИМЯ`. */
const CYGPATH = /^\$\(cygpath(?:\s+-[wmua]+)*\s+((?:[^\s$`()"';&|<>%^]|\$\{?[A-Za-z_]\w*\}?)+)\)$/;
/** Пробел и знаки строки `cmd` (соединение команд, вывод, `%ИМЯ%`) — путь не проследить. */
const CMD_UNSAFE = /[\s"&|<>^%]/;

/** Путь операнда `mklink`: слово как есть или путь из `$(cygpath …)` (переменные раскроет обход). */
function cmdOperand(word: Word): Word | undefined {
  if (!word.dynamic) return CMD_UNSAFE.test(word.text) ? undefined : word;
  const path = CYGPATH.exec(word.text)?.[1];
  return path === undefined
    ? undefined
    : { text: path, dynamic: path.includes('$'), unsplit: true };
}

/** Строка `cmd` одним словом, где кроме слов через пробел ничего: ни кавычек, ни соединений, ни `%ИМЯ%`. */
const CMD_STRING = /^mklink(\.exe)?\s[^"&|<>^%()!]*$/i;

/**
 * `cmd //c "mklink /J a b"` (D-12, 26.10) — вся строка `cmd` одним словом: слова
 * её те же, что у `cmd //c mklink /J a b`. Только простая строка — без кавычек,
 * соединений и подстановок `cmd`; иначе `undefined`, как раньше.
 */
function splitCmdString(args: Word[]): Word[] | undefined {
  const last = args.at(-1);
  if (!last || last.dynamic || !CMD_STRING.test(last.text)) return undefined;
  const words = last.text
    .trim()
    .split(/\s+/)
    .map((text): Word => ({ text, dynamic: false }));
  return [...args.slice(0, -1), ...words];
}

/**
 * `cmd /c mklink /J|/D <ссылка> <цель>` (D-7, 25.10) — ссылка каталога, у которой
 * оба пути названы словами или `$(cygpath -w путь)`; вся строка `cmd` одним
 * простым словом — те же слова (D-12). Что-то сверх этого в строке `cmd` (вторая
 * команда, другой ключ, путь из иной подстановки) — `undefined`: путь не
 * проследить, как раньше. `args` — без самого `cmd`.
 */
export function cmdMklink(args: Word[]): { link: Word; target: Word } | undefined {
  const at = args.findIndex((arg) => /^mklink(\.exe)?$/i.test(arg.text));
  if (at < 0) {
    const split = splitCmdString(args);
    return split ? cmdMklink(split) : undefined;
  }
  const switches = args.slice(0, Math.max(at, 0));
  if (at < 1 || !switches.every((arg) => CMD_SWITCH.test(arg.text))) return undefined;
  if (!switches.some((arg) => /^\/\/?[ck]$/i.test(arg.text))) return undefined;
  const rest = args.slice(at + 1);
  const flags = rest.filter((arg) => MKLINK_SWITCH.test(arg.text));
  const paths = rest.filter((arg) => !MKLINK_SWITCH.test(arg.text));
  if (flags.length !== 1 || !MKLINK_DIR.test((flags[0] as Word).text) || paths.length !== 2) {
    return undefined;
  }
  const link = cmdOperand(paths[0] as Word);
  const target = cmdOperand(paths[1] as Word);
  return link && target ? { link, target } : undefined;
}

/** Операнды без ключей и значений ключей; значение `-t` — каталог ссылок. */
function operands(args: Word[]): { rest: Word[]; directory: Word | undefined } {
  const rest: Word[] = [];
  let directory: Word | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (VALUED.test(arg.text)) {
      if (/^(-t|--target-directory)$/.test(arg.text)) directory = args[i + 1];
      i += 1;
    } else if (arg.text.startsWith('--target-directory=')) {
      directory = { ...arg, text: arg.text.slice('--target-directory='.length) };
    } else if (arg.dynamic || !arg.text.startsWith('-')) rest.push(arg);
  }
  return { rest, directory };
}

/**
 * Где звено заведёт ссылки: слова путей (`undefined` в списке — путь не узнать,
 * например ссылка внутри строки `cmd` или PowerShell). Пустой список — звено
 * ссылок не заводит. `ln a b` и `ln a dir/` — ссылка `b` или внутри `dir`:
 * отмечается сам приёмник, всё ниже него — через ссылку; `ln a` — имя `a` в
 * текущем каталоге. `name` — имя команды без пути, `.exe` и регистра.
 */
export function linkPaths(name: string, words: Word[]): (Word | undefined)[] {
  const args = words.slice(1);
  switch (name) {
    case 'ln':
    case 'cp': {
      if (name === 'cp' && !args.some((arg) => CP_LINKS.test(arg.text))) return [];
      const { rest, directory } = operands(args);
      if (directory) return [directory];
      if (name === 'ln' && rest.length === 1) {
        const [target] = rest as [Word];
        if (target.dynamic) return [undefined];
        return [
          {
            text:
              target.text
                .replace(/[\\/]+$/, '')
                .split(/[\\/]/)
                .at(-1) ?? '',
            dynamic: false,
          },
        ];
      }
      return [rest.at(-1)];
    }
    case 'mklink':
    case 'junction':
      return [operands(args.filter((arg) => !/^\/\/?[a-z]$/i.test(arg.text))).rest[0]];
    case 'fsutil':
      return args[0]?.text.toLowerCase() === 'hardlink' ? [args[2]] : [];
    case 'mount':
    case 'bindfs':
      return name === 'bindfs' || args.some((arg) => /bind/.test(arg.text)) ? [args.at(-1)] : [];
    case 'cmd': {
      // Названная ссылка каталога — в учёт её путём (D-7); иначе — «где угодно».
      const made = cmdMklink(args);
      if (made) return [made.link];
      return args.some((arg) => MKLINK.test(arg.text)) ? [undefined] : [];
    }
    case 'powershell':
    case 'pwsh':
    case 'new-item':
    case 'ni':
      return args.some((arg) => PS_LINK.test(arg.text)) ? [undefined] : [];
    default:
      return [];
  }
}

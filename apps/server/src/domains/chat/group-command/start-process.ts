/**
 * `Start-Process` PowerShell — запуск программы мимо разбора (I-04, I-08).
 *
 * `Start-Process git -ArgumentList 'branch','-D','other'` и `Start-Process cmd
 * -ArgumentList '/c','rd','/s','/q','C:\x'` разбор судил как незнакомую команду
 * PowerShell: имя git или удаление стоят в кавычках списка, и группа удаляла
 * чужую ветку сама. Здесь — то, что запустится на самом деле: программа и её
 * аргументы одной строкой (`Start-Process` склеивает список через пробел, так
 * его видит и программа). Строку смотрят правила автоподтверждения чата
 * (`auto-approve.ts` `ruleFor`) вдобавок к целой команде — ослабить это не может.
 * Строки группы судит `powershellLaunchDestroys` (`group-tree-state.ts`).
 *
 * Чего не видно: имя программы в переменной (`Start-Process $g`) — такое
 * звено остаётся каким было (разбор целой строки), склейка — на всё прочее.
 */

/** Слово PowerShell: значение без кавычек и было ли за ним `,` (элемент списка). */
interface Token {
  text: string;
  comma: boolean;
  quoted: boolean;
}

/** Имена `Start-Process` (командлет и его псевдонимы). */
const START_NAMES = new Set(['start-process', 'start', 'saps']);

/** Ключи `Start-Process` со значением: их значение — не аргумент программы. */
const VALUE_PARAMS = /^-(?:wo|work|redirect|r|windowstyle|wi|verb|v|credential|cr|environment|e)/i;
/** Ключи-переключатели `Start-Process`. */
const SWITCH_PARAMS =
  /^-(?:nonewwindow|nonew|non|n|passthru|pa|wait|wa|loaduserprofile|l|usenewenvironment|u)\w*$/i;

/** Слова одного звена PowerShell: кавычки `'…'` (`''` внутри) и `"…"`, запятые списка. */
function tokens(segment: string): Token[] | undefined {
  const out: Token[] = [];
  let i = 0;
  while (i < segment.length) {
    const char = segment[i] as string;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === ',') {
      const last = out[out.length - 1];
      if (last) last.comma = true;
      i += 1;
      continue;
    }
    let text = '';
    let quoted = false;
    while (i < segment.length && !/[\s,]/.test(segment[i] as string)) {
      const c = segment[i] as string;
      if (c === "'" || c === '\u2018' || c === '\u2019') {
        // Кавычка первым знаком — слово-строка, не ключ: `'-Wait'` — аргумент.
        if (text === '') quoted = true;
        i += 1;
        while (i < segment.length) {
          const d = segment[i] as string;
          if ((d === "'" || d === '\u2018' || d === '\u2019') && segment[i + 1] === d) {
            text += d;
            i += 2;
            continue;
          }
          if (d === "'" || d === '\u2018' || d === '\u2019') break;
          text += d;
          i += 1;
        }
        if (i >= segment.length) return undefined;
        i += 1;
        continue;
      }
      if (c === '"' || c === '\u201C' || c === '\u201D') {
        // Кавычка первым знаком — слово-строка, не ключ: `'-Wait'` — аргумент.
        if (text === '') quoted = true;
        i += 1;
        while (i < segment.length && !/["\u201C\u201D]/.test(segment[i] as string)) {
          // `` `" `` — кавычка внутри строки PowerShell.
          if (segment[i] === '`' && i + 1 < segment.length) {
            text += segment[i + 1];
            i += 2;
            continue;
          }
          text += segment[i];
          i += 1;
        }
        if (i >= segment.length) return undefined;
        i += 1;
        continue;
      }
      text += c;
      i += 1;
    }
    out.push({ text, comma: false, quoted });
  }
  return out;
}

/** Звенья строки по `;`, `|`, `&&`, `||` и переводу строки — вне кавычек. */
function segments(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r' || char === '&') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Имя программы без пути и `.exe`: `C:\Program Files\Git\cmd\git.exe` → `git`. */
function programName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '');
}

/** Значение ключа или позиционного места — слово и его продолжение списком через `,`. */
function listAt(list: Token[], at: number): { values: string[]; next: number } {
  const values: string[] = [];
  let next = at;
  while (next < list.length) {
    const token = list[next] as Token;
    values.push(token.text);
    next += 1;
    if (!token.comma) break;
  }
  return { values, next };
}

/** Одно звено `Start-Process …` → `программа аргументы`, или `undefined` — не оно. */
function flattenSegment(segment: string): string | undefined {
  const list = tokens(segment.replace(/^&\s*/, ''));
  if (!list || list.length < 2) return undefined;
  if (!START_NAMES.has((list[0] as Token).text.toLowerCase())) return undefined;
  let program: string | undefined;
  const args: string[] = [];
  const positional: string[][] = [];
  let at = 1;
  while (at < list.length) {
    const token = list[at] as Token;
    const word = token.quoted ? '' : token.text;
    // `-ArgumentList:'x'` — значение через двоеточие.
    const [name, glued] = word.startsWith('-') ? word.split(/:(.*)/s) : [word, undefined];
    if (name && /^-(?:f|filepath|path|pspath)\w*$/i.test(name) && !/^-(?:fo)/i.test(name)) {
      if (glued) {
        program = glued;
        at += 1;
      } else {
        const { values, next } = listAt(list, at + 1);
        program = values[0];
        at = next;
      }
      continue;
    }
    if (name && /^-(?:a|arg|args|argumentlist)\w*$/i.test(name)) {
      if (glued) {
        args.push(glued);
        at += 1;
      } else {
        const { values, next } = listAt(list, at + 1);
        args.push(...values);
        at = next;
      }
      continue;
    }
    if (name && SWITCH_PARAMS.test(name)) {
      at += 1;
      continue;
    }
    if (name && VALUE_PARAMS.test(name)) {
      at += glued ? 1 : 2;
      continue;
    }
    const { values, next } = listAt(list, at);
    positional.push(values);
    at = next;
  }
  // Позиционно: первое — программа, второе — список аргументов (как у командлета).
  const rest = [...positional];
  if (program === undefined) program = rest.shift()?.[0];
  if (args.length === 0 && rest.length > 0) args.push(...(rest.shift() ?? []));
  // Неузнанное — тоже в строку: лишнее слово делает суд строже, не мягче.
  for (const values of rest) args.push(...values);
  if (!program || program.startsWith('$')) return undefined;
  return [programName(program), ...args].join(' ').trim();
}

/**
 * Строки, которые запустят звенья `Start-Process` команды PowerShell; пусто —
 * таких звеньев нет. Каждую судит разбор, как команду Bash.
 */
export function startProcessLines(command: string): string[] {
  return segments(command)
    .map(flattenSegment)
    .filter((line): line is string => Boolean(line));
}

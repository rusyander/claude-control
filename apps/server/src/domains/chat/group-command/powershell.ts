import { parse, UNPARSED, type Word } from './shell-parse.ts';
import type { Unwrapped } from './wrappers.types.ts';

/**
 * `powershell`/`pwsh` как обёртка. Вынесено из `wrappers.ts` по размеру.
 *
 * Ключи PowerShell пишутся через `-`, `/`, `--` (и типографское тире), а имя
 * — любым однозначным началом: `-e`, `-ec`, `-enco`, `/e` — всё это
 * `-EncodedCommand`. Раньше разбор знал только `-e`/`-ec`/полное имя и только
 * первым словом, и `-enco …`, `/e …`, `-nop -enco …` проходили сами (ревью
 * 23.10, R-05).
 */

const PS_VALUE_FLAGS =
  /^-(ExecutionPolicy|ep|ex|WindowStyle|w|InputFormat|if|OutputFormat|of|Version|v|ConfigurationName)$/i;
/** Каталог, где пойдёт команда (`pwsh -wd C:\ -c …`): судится там, как после `cd` (R-04). */
const PS_CWD_FLAGS = /^-(WorkingDirectory|wd)$/i;
const PS_FLAGS = /^-(NoProfile|nop|NonInteractive|noni|NoLogo|nol|Sta|Mta|NoExit|noe)$/i;
/** Синтаксис PowerShell, с которым строку не разобрать по пробелам: переменные, блоки, массивы. */
const PS_META = /[$`;|&(){}@<>'"#,]/;
/** Имена удаления в PowerShell — все означают `Remove-Item` (и `rm`, и `del`, и `ri`). */
const PS_REMOVERS = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']);

/**
 * Строка `git …` без синтаксиса, в котором PowerShell и Bash расходятся:
 * переменные, подстановки, блоки, перенаправления, обратный слеш, `''` внутри
 * кавычек. Простые `'…'` и `"…"` у них читаются одинаково, поэтому такая
 * строка разбирается как в Bash и судится разбором git (раунд 10, 24.10):
 * инструмент PowerShell судится этой обёрткой, и без снятия любой его `git
 * commit` шёл бы человеку как запись git в обёртке.
 */
const PS_GIT_UNSAFE = /[$`(){}@<>;|&#,\\]|''|""/;

/**
 * Где PowerShell и Bash делят строку по-разному (повторная проверка 24.10):
 * типографские кавычки у PowerShell — кавычки (`HEAD:‘main’` — это
 * `HEAD:main`), типографское тире — дефис ключа, одиночный CR — конец
 * оператора, неразрывный и прочие пробелы Юникода — пробел. Bash всё это
 * читает буквами: `git push origin “HEAD:main”` выглядел пушем в ветку
 * `“HEAD:main”`, а `git status<CR>Remove-Item … C:/Users/…` — одним `git
 * status`. Такая строка не снимается: её судит обёртка целиком.
 */
const PS_BASH_SPLIT = /[\u2018-\u201E\u2013-\u2015]|[^\S \t]/;

function gitLine(line: string, cwd: Word | undefined): Unwrapped | undefined {
  if (!/^git(\.exe)?[ \t]/i.test(line) || PS_GIT_UNSAFE.test(line)) return undefined;
  if (PS_BASH_SPLIT.test(line)) return undefined;
  const steps = parse(line);
  if (steps === UNPARSED || steps.length !== 1) return undefined;
  const only = steps[0];
  if (typeof only !== 'object' || only.redirects.length > 0 || only.inputs.length > 0) {
    return undefined;
  }
  if (only.words.some((word) => word.dynamic)) return undefined;
  return { kind: 'command', words: only.words, ...(cwd ? { cwd } : {}) };
}

/** Имя ключа без знака (`-`, `/`, `--`, тире) и без `:значения`; `undefined` — не ключ. */
function switchKey(text: string): string | undefined {
  const match = /^(?:--|[-/\u2013\u2014\u2015])([^:]+)/.exec(text);
  return match ? (match[1] as string).toLowerCase() : undefined;
}

/** `-EncodedCommand`, `-EncodedArguments` любым началом и `-ec`, `-ea`. */
const encoded = (key: string): boolean =>
  'encodedcommand'.startsWith(key) ||
  'encodedarguments'.startsWith(key) ||
  key === 'ec' ||
  key === 'ea';

/**
 * Закодированный код до команды или файла — где угодно среди ключей, а не
 * только первым словом. Значения известных ключей пропускаются: путь
 * `-wd /e` — не ключ.
 */
function runsEncoded(args: Word[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    const key = switchKey(text);
    if (key === undefined) return false;
    if (encoded(key)) return true;
    if ('command'.startsWith(key) || 'file'.startsWith(key)) return false;
    if (PS_VALUE_FLAGS.test(text) || PS_CWD_FLAGS.test(text)) i += 1;
  }
  return false;
}

/**
 * `powershell -NoProfile -c "Remove-Item -Recurse -Force dist"`: удаление
 * простыми словами судится по целям, как `rm -rf dist`, — раньше любое удаление
 * в PowerShell шло человеку, даже сборки своей копии (ревью 23.10, зона A).
 * Снимаем только удаление без синтаксиса PowerShell: прочие команды в нём
 * разбор не знает, их судит обёртка целиком. Диски PowerShell (`HKCU:`, `Env:`)
 * — не файлы копии, их не снимаем. `-EncodedCommand` — код, которого не прочесть.
 * `-File x.ps1` не снимается: сценарий из файла судится, как `bash x.sh`, —
 * обёртка целиком, словами.
 */
export function powershellUnwrap(args: Word[]): Unwrapped | undefined {
  if (runsEncoded(args)) return { kind: 'danger' };
  let cwd: Word | undefined;
  let i = 0;
  for (; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (PS_CWD_FLAGS.test(text)) {
      i += 1;
      cwd = args[i] ?? { text: '', dynamic: true };
    } else if (PS_VALUE_FLAGS.test(text)) i += 1;
    else if (!PS_FLAGS.test(text)) break;
  }
  if (!/^-(Command|c)$/i.test(args[i]?.text ?? '')) return undefined;
  const body = args.slice(i + 1);
  if (body.some((word) => word.dynamic)) return undefined;
  const line = body.map((word) => word.text).join(' ');
  if (PS_META.test(line)) return gitLine(line, cwd);
  const [name = '', ...tail] = line.split(/\s+/).filter(Boolean);
  if (!PS_REMOVERS.has(name.toLowerCase())) return gitLine(line, cwd);
  // `-Path:C:\x` — цель внутри ключа: снятое удаление её бы не увидело.
  if (tail.some((text) => /^[A-Za-z]{2,}:|^-\w+:/.test(text))) return undefined;
  const words = tail.map((text): Word => ({ text, dynamic: text.startsWith('~') }));
  const command: Word[] = [{ text: 'Remove-Item', dynamic: false }, ...words];
  return { kind: 'command', words: command, ...(cwd ? { cwd } : {}) };
}

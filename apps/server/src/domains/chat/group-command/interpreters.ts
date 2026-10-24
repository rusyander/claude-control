import type { Word } from './shell-parse.ts';

/**
 * Код интерпретатора в словах звена: `python -c`, `node -e`, `ruby -e`,
 * `perl -E`. Раньше брался только первый флаг из общего списка, и `-r`/`-E`
 * считались флагами кода у всех: `node -r ./x.js -e 1` проверял `./x.js` как
 * код, `ruby -E utf-8 -e '…'` — кодировку, `node -pe '…'` не видел вовсе
 * (ревью 23.10, F-07).
 *
 * Здесь у каждого языка своя таблица флагов: код проверяется у КАЖДОГО флага
 * кода, слитные флаги (`-pe`, `-lne`) разбираются по буквам, а подгрузка
 * модуля или файла (`node -r`, `ruby -r`, `perl -M`, `php -d`) — чужой код,
 * как `node x.js`: звено остаётся «прочим» и непроверенным.
 */
export interface InterpreterCode {
  /** Тексты кода всех флагов кода. */
  codes: string[];
  /** Исполнится и код, которого здесь нет: файл сценария, подгрузка, модуль. */
  file: boolean;
}

interface Spec {
  /** Буквы, берущие код значением. */
  code: string;
  /** Буквы, берущие файл или модуль, который подгрузится. */
  preload: string;
  /** Буквы со значением слитно или отдельным словом. */
  value: string;
  /** Буквы со значением только слитно (`perl -I/lib`, `-i.bak`). */
  attached: string;
  long: Record<string, 'code' | 'preload' | 'value' | 'flag'>;
  /** Код или модуль кончает разбор: дальше — аргументы программы (`python -c`). */
  stops: boolean;
  /** Значение короткого флага бывает слитным: `python -c'…'`, `ruby -rjson`. */
  inline: boolean;
}

const NODE: Spec = {
  code: 'ep',
  preload: 'r',
  value: 'C',
  attached: '',
  long: {
    eval: 'code',
    print: 'code',
    require: 'preload',
    import: 'preload',
    loader: 'preload',
    'experimental-loader': 'preload',
    'env-file': 'preload',
    'input-type': 'value',
    conditions: 'value',
  },
  stops: false,
  inline: false,
};
const PYTHON: Spec = {
  code: 'c',
  preload: 'm',
  value: 'WX',
  attached: '',
  long: { 'check-hash-based-pycs': 'value' },
  stops: true,
  inline: true,
};
const RUBY: Spec = {
  code: 'e',
  preload: 'r',
  value: 'EIC',
  attached: 'FTKx0',
  long: { require: 'preload', encoding: 'value' },
  stops: false,
  inline: true,
};
const PERL: Spec = {
  code: 'eE',
  preload: 'Mmd',
  value: '',
  attached: 'IilxCDFV0',
  long: {},
  stops: false,
  inline: true,
};
const PHP: Spec = {
  code: 'rBRE',
  preload: 'fFdcz',
  value: '',
  attached: '',
  long: {},
  stops: false,
  inline: true,
};

const SPECS: [RegExp, Spec][] = [
  [/^(node|nodejs|bun|tsx|ts-node)$/, NODE],
  [/^(python[\d.]*|py)$/, PYTHON],
  [/^ruby$/, RUBY],
  [/^perl$/, PERL],
  [/^php$/, PHP],
];

function shortFlags(
  text: string,
  next: Word | undefined,
  spec: Spec,
  found: InterpreterCode,
): { used: number; stop: boolean } {
  for (let j = 1; j < text.length; j += 1) {
    const letter = text[j] as string;
    const rest = text.slice(j + 1);
    const takes = spec.code.includes(letter)
      ? 'code'
      : spec.preload.includes(letter)
        ? 'preload'
        : spec.value.includes(letter)
          ? 'value'
          : undefined;
    if (spec.attached.includes(letter)) return { used: 1, stop: false };
    if (!takes) continue;
    // `node -pe '…'` — два флага на одно слово кода: слитного значения у node нет.
    const inline = spec.inline ? rest : '';
    const value = inline || next?.text;
    const used = inline ? 1 : 2;
    if (takes === 'code') found.codes.push(value ?? '');
    if (takes === 'preload') found.file = true;
    return { used, stop: spec.stops && takes !== 'value' };
  }
  return { used: 1, stop: false };
}

function longFlag(
  text: string,
  next: Word | undefined,
  spec: Spec,
  found: InterpreterCode,
): number {
  const [name = '', inline] = text.slice(2).split(/=(.*)/s);
  const kind = spec.long[name] ?? 'flag';
  if (kind === 'flag') return 1;
  const value = inline ?? next?.text;
  if (kind === 'code') found.codes.push(value ?? '');
  if (kind === 'preload') found.file = true;
  return inline === undefined ? 2 : 1;
}

/** Код в словах интерпретатора `base` (имя без пути и `.exe`); `undefined` — не интерпретатор. */
export function interpreterCode(base: string, args: Word[]): InterpreterCode | undefined {
  const name = base.toLowerCase().replace(/\.exe$/, '');
  if (name === 'deno') {
    // `deno eval '…'` — код; `deno run x.ts` и прочее — файл.
    return args[0]?.text === 'eval'
      ? { codes: [args[1]?.text ?? ''], file: false }
      : { codes: [], file: true };
  }
  const spec = SPECS.find(([pattern]) => pattern.test(name))?.[1];
  if (!spec) return undefined;
  const found: InterpreterCode = { codes: [], file: false };
  for (let i = 0; i < args.length;) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (text === '--') {
      if (args[i + 1]) found.file = true;
      break;
    }
    if (text === '-') break;
    if (!text.startsWith('-') || arg.dynamic) {
      // Первое позиционное слово — файл сценария; после него — его аргументы.
      found.file = true;
      break;
    }
    if (text.startsWith('--')) {
      i += longFlag(text, args[i + 1], spec, found);
      continue;
    }
    const { used, stop } = shortFlags(text, args[i + 1], spec, found);
    i += used;
    if (stop) break;
  }
  return found;
}

const INTERPRETERS = /^(python[\d.]*|py|node|nodejs|ruby|perl|php|deno|bun|tsx|ts-node)(\.exe)?$/i;

export function isInterpreter(name: string): boolean {
  return INTERPRETERS.test(name.split(/[\\/]/).at(-1) ?? '');
}

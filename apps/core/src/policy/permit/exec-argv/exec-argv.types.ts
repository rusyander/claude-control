/**
 * Диалект строки команды: как её разберёт оболочка, которая её исполнит. `lenient` — bash, где
 * `\` экранирует только знаки оболочки: второе чтение для путей Windows (`bash.ts`).
 */
export type Dialect = 'bash' | 'lenient' | 'cmd' | 'ps';

/** Что придёт команде на stdin: текст (here-doc, here-string) или выход прошлого звена `|`. */
export type Stdin = { kind: 'text'; text: string } | { kind: 'pipe' };

/** Простая команда строки: слова без кавычек, вход, цели перенаправлений. */
export interface ParsedCommand {
  words: string[];
  stdin?: Stdin;
  redirects: string[];
}

export interface ParsedScript {
  /** Слова команд по порядку (то же, что `commands[].words`). */
  chains: string[][];
  commands: ParsedCommand[];
  /** Тексты подстановок `$(…)`, `` `…` ``, `<(…)` — каждая тоже исполнится, в том же диалекте. */
  substitutions: string[];
  /** Что разобрать до конца нельзя (вызов значения, собранного на лету). */
  unknown: string[];
}

/** Слово команды для сверки с путями: чьё оно, что стоит перед ним, цель ли перенаправления. */
export interface ExecWord {
  text: string;
  /** Имя команды (`commandName` первого слова после присваиваний). */
  head: string;
  /** Предыдущее слово команды (опция перед значением). */
  prev: string;
  redirect: boolean;
}

export interface ExecAnalysis {
  /** Все формы, под которыми команды исполнятся (исходный argv первым). */
  forms: string[][];
  /** Дороги публикации, невидимые префиксу: псевдоним из окружения, запись pushurl / hooksPath. */
  hazards: string[];
  /** Что разбор не прошёл до конца (предел, вход из трубы, вызов собранного значения). */
  unknown: string[];
  /** Каждое слово команд и цели перенаправлений — для сверки с путями платформы. */
  words: ExecWord[];
  /** Куда строка переходит `cd`; `cwdUnknown` — переход в каталог, которого не видно. */
  cwds: string[];
  cwdUnknown: boolean;
}

export type Env = Map<string, string>;

/** Обход: исполняет текст или argv так, как его исполнит оболочка, копя формы и находки. */
export interface Visitor {
  acc: ExecAnalysis;
  script(
    text: string,
    dialect: Dialect,
    env: Env,
    aliases: ReadonlyMap<string, string>,
    depth: number,
  ): void;
  argv(
    argv: readonly string[],
    env: Env,
    aliases: ReadonlyMap<string, string>,
    depth: number,
    stdin?: Stdin,
  ): void;
  /** Вход команды, которая читает скрипт со stdin: текст — исполнить, труба — неизвестно. */
  stdin(
    stdin: Stdin | undefined,
    dialect: Dialect,
    env: Env,
    aliases: ReadonlyMap<string, string>,
    depth: number,
    who: string,
  ): void;
}

export interface AnalyzeOptions {
  /** Домашний каталог: им раскрываются `~`, `$HOME`, `%USERPROFILE%`. */
  home?: string;
  /** Первые слова запрещённых префиксов (`git`, `gh`…): слово-команда в аргументах обёртки. */
  heads?: readonly string[];
  /** Оболочка, которой CLI исполнит строку: `ps` — инструмент PowerShell, иначе bash. */
  primary?: 'bash' | 'ps';
}

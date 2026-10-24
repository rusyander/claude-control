import type { KillTargets } from './kill.ts';
import type { CodeRule } from './risky.ts';
import type { Word } from './shell-parse.ts';
import { checkedOut, DETACHED } from './branch.ts';
import { portMarkPorts, portQueryPorts } from './port-query.ts';
import { canonical, escapesBase, real, resolveFrom, within } from './paths.ts';
import { ShellState } from './shell-state.ts';

export { isProtectedBranch } from './branch.ts';

export interface GroupCommandScope {
  /** Копия группы — каталог прогона; `undefined` — неизвестна. */
  worktree?: string;
  /** Ветка, на которой стоит копия по git, если она не основная. */
  branch?: string;
  /** Ветка по умолчанию у `origin` (`origin/HEAD`) — защищена, как `main`. */
  base?: string;
  /**
   * Что git в копии игнорирует, кроме временного (`git ls-files -o -i --directory`),
   * — пути от корня копии. Такое git не вернёт: локальный слой, секреты. Есть
   * список — удаление прочего в копии разрешено как своё (отслеживаемое вернёт
   * git, неотслеживаемое в своей копии — работа самой группы); нет — удаление
   * невременного решает человек, как раньше.
   */
  ignored?: readonly string[];
  /** Копии, чьи записи снесёт `git worktree prune` сейчас; нет — `prune` решает человек. */
  prunable?: readonly string[];
  /**
   * Каталог оболочки CLI перед командой — из записи транскрипта с этим вызовом
   * (N4, 23.10: после `cd inst-docs-ui` прошлой командой `../.agent/tmp/x`
   * судился от корня копии и уходил «из копии»). Только внутри копии: каталог
   * вне её или ведущий наружу по ссылке не в счёт — каталог неизвестен.
   * Не задан — тоже неизвестен (F-29): относительное невременное удаление тогда
   * человеку, остальное судится от корня копии, как раньше.
   */
  cwd?: string;
  /**
   * Рабочая папка CLI ЭТОЙ сессии группы (`<TEMP>/claude/<проект>/<сессия>/scratchpad`).
   * Удаление в ней — уборка; в чужой папке другой сессии — человеку (решение
   * владельца 23.10, F-77). Не задана — уборкой не считается ни одна.
   */
  scratchpad?: string;
  /**
   * Псевдонимы оболочки Bash-инструмента из снимка оболочки CLI (раунд 10):
   * имя команды, совпавшее с псевдонимом, раскрывается до суда, как это сделает
   * оболочка (`expand_aliases` в снимке включён). Нет — имя судится, как написано.
   */
  aliases?: Readonly<Record<string, string>>;
  /**
   * Функции того же снимка (`.bashrc`, повторная проверка 24.10): имя команды,
   * совпавшее с функцией, исполняет её тело — оно и судится (`group-command.ts`
   * `functionVerdict`). Нет — имя судится, как написано.
   */
  functions?: Readonly<Record<string, string>>;
}

/** `$(git branch --show-current)` и родственные — имя текущей ветки. */
const CURRENT_BRANCH =
  /\$\(git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+(?:-q\s+|--quiet\s+)?--short\s+HEAD)\)/g;
/** Подъём `..` в пути. */
const UP = /(^|[\\/])\.\.([\\/]|$)/;
const VARIABLE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
/** `${ИМЯ:-слово}`, `${ИМЯ-слово}`: запасное слово без подстановок и `~` — буквально. */
const DEFAULTED = /\$\{([A-Za-z_]\w*)(:?)[-=]([^{}$`~'"\\]*)\}/g;
/** Раскрытие фигурных скобок: `{a,b}`, `{1..3}` — уже несколько слов. */
const BRACES = /\{[^{}]*(,|\.\.)[^{}]*\}/;

/**
 * Окружение git, которое не уводит его в другой репозиторий: подпись, трассировка,
 * пейджер, редактор. Прочие `GIT_*` (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_CONFIG_*`) решают, с каким репозиторием и как работает git. Те, что
 * запускают программу (редактор, пейджер, `GIT_SSH_COMMAND`), репозиторий не
 * меняют, но их значение судит `git-env.ts` правилами `-c`.
 */
const SAFE_GIT_ENV =
  /^GIT_(PAGER|TRACE\w*|AUTHOR_\w+|COMMITTER_\w+|TERMINAL_PROMPT|OPTIONAL_LOCKS|EDITOR|SEQUENCE_EDITOR|ASKPASS|SSH|SSH_COMMAND|EXTERNAL_DIFF|PROXY_COMMAND|CONFIG_NOSYSTEM|PROGRESS_DELAY|MERGE_AUTOEDIT|FLUSH|REDIRECT_STDERR|CEILING_DIRECTORIES|LFS_SKIP_SMUDGE)$/;

/**
 * Имя — в верхнем регистре: окружение Windows регистра не различает, и Git for
 * Windows читает `git_dir` как `GIT_DIR` (ревью 23.10, A-01: строчные имена шли
 * рутиной). На Linux и macOS лишняя осторожность ничего не ломает: разбор не
 * знает, где исполнится команда.
 */
export function steersGit(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('GIT_') && !SAFE_GIT_ENV.test(upper);
}

/**
 * Абсолютный путь — и `C:dist` тоже: у MSYS (`rm`, `cp` Git Bash) это `C:/dist`,
 * у PowerShell — от текущего каталога диска, которого разбор не знает. Раньше
 * `C:dist` считался путём от каталога звена и удалялся как свой (ревью 23.10).
 */
export function isAbsolute(path: string): boolean {
  return /^([a-zA-Z]:|[\\/])/.test(path);
}

export type SegmentVerdict =
  | {
      kind: 'routine';
      writes?: boolean;
      lease?: boolean;
      deletes?: boolean;
      /** Номера и порты, которые звено гасит: чьи они — решает маршрут прав. */
      kills?: KillTargets;
    }
  | { kind: 'danger' }
  /**
   * `rules` — правила чата, найденные проверкой кода; `checked` — текст звена уже
   * проверен (код интерпретатора) и правилам чата по словам не отдаётся.
   */
  | { kind: 'other'; rules?: CodeRule[]; checked?: boolean };

export const ROUTINE: SegmentVerdict = { kind: 'routine' };
export const OTHER: SegmentVerdict = { kind: 'other' };
export const DANGER: SegmentVerdict = { kind: 'danger' };

/** Обработчик `trap`: исполнится при выходе, с тем состоянием, что будет тогда. */
export interface Deferred {
  script: string;
  /** Поставлен в подоболочке: её состояние к выходу не проследить. */
  blind: boolean;
}

export class Walk extends ShellState {
  readonly base: string | undefined;
  readonly ignored: readonly string[] | undefined;
  readonly prunable: readonly string[] | undefined;
  readonly aliases: Readonly<Record<string, string>> | undefined;
  readonly functions: Readonly<Record<string, string>> | undefined;
  /** Псевдонимы, что раскрываются сейчас: оболочка не раскрывает имя внутри его же развёртки. */
  readonly expanding = new Set<string>();
  private readonly roots: string[];
  private readonly scratchpad: string | undefined;
  /**
   * Ветка копии сейчас: сначала — по git, после `checkout` в команде — та, что
   * выбрана. Ветка — состояние репозитория, а не оболочки: подоболочка её не прячет.
   */
  private branch: string | undefined;
  /** В этой же команде уже сменили ветку: аренда дальше — не своей ветки. */
  private switched = false;
  /**
   * Голова точно отсоединена в этой команде (`checkout --detach`, коммит) — ветка,
   * что была до этого: не выйдет `checkout` (грязное дерево, `;`), слияние ляжет в неё.
   */
  private detachedFrom: string | undefined;
  private readonly own: string | undefined;
  private readonly deferred: Deferred[] = [];

  /**
   * Значение переменной, которой в этой команде присвоили `$!`, — фоновый
   * ребёнок самой оболочки (`npm run dev & P=$!; …; kill $P`). Метка случайная:
   * руками её не написать, и `kill <метка>` словами своим ребёнком не станет.
   */
  readonly childMark = `child.${Math.random().toString(36).slice(2)}`;

  /**
   * Начало значения «номера держателей портов» — переменная из запроса порта
   * (`P=$(netstat … | grep ':5173 ' | grep LISTENING | awk …)`, R-C03): за меткой
   * — порты через запятую. Метка случайная, руками её не написать.
   */
  readonly portMark = `port.${Math.random().toString(36).slice(2)}:`;

  constructor(scope: GroupCommandScope) {
    super();
    const worktree = scope.worktree;
    const roots = worktree ? [canonical(worktree), real(worktree)] : [];
    this.roots = [...new Set(roots.filter((root): root is string => Boolean(root)))];
    const start = worktree ? this.startDir(canonical(worktree), scope.cwd) : undefined;
    this.cwd = start?.cwd;
    this.guessed = start?.guessed ?? false;
    this.own = scope.branch;
    this.branch = scope.branch;
    this.base = scope.base;
    this.ignored = scope.ignored;
    this.prunable = scope.prunable;
    this.aliases = scope.aliases;
    this.functions = scope.functions;
    this.scratchpad = scope.scratchpad ? canonical(scope.scratchpad) : undefined;
  }

  /**
   * Откуда начинать: каталог оболочки CLI, если он в копии под ОБОИМИ
   * написаниями — как записан и настоящим путём (каталог-ссылка внутри копии,
   * ведущая наружу, копией не считается). Каталог известен и он вне копии —
   * каталог неизвестен: относительные пути там правда смотрят наружу.
   * Каталога нет — корень копии, но «угаданный» (`guessed`, F-29): оболочка
   * могла уйти куда угодно соседним вызовом, и относительное удаление
   * невременного решает человек. `anchored` не ставится: оболочка могла сменить
   * каталог соседним вызовом того же ответа после записи транскрипта.
   */
  private startDir(
    root: string,
    shell: string | undefined,
  ): { cwd: string | undefined; guessed: boolean } {
    if (!shell || !isAbsolute(shell)) return { cwd: root, guessed: true };
    const path = canonical(shell);
    const spellings = [path, real(path)].filter((entry): entry is string => Boolean(entry));
    const inside = spellings.every((entry) => this.roots.some((copy) => within(entry, copy)));
    return { cwd: inside ? path : undefined, guessed: false };
  }

  /** Место звена для суждения о путях. */
  place(): { cwd: string | undefined; anchored: boolean; guessed: boolean } {
    return { cwd: this.cwd, anchored: this.anchored, guessed: this.guessed };
  }

  /** `cd`: абсолютный путь — каталог известен точно, относительный — от прежнего. */
  override changeDir(dir: Word | undefined): void {
    if (!dir || dir.dynamic || dir.text === '-' || this.blinded) {
      this.cwd = undefined;
      return;
    }
    if (isAbsolute(dir.text)) {
      this.cwd = resolveFrom('/', dir.text);
      this.anchored = true;
      this.guessed = false;
    } else if (this.cdpath && !/^\.\.?([\\/]|$)/.test(dir.text)) {
      // `CDPATH` задан: `cd me` уйдёт в его каталог, а не в подкаталог (F-16).
      this.cwd = undefined;
    } else {
      this.cwd = this.cwd ? resolveFrom(this.cwd, dir.text) : undefined;
    }
  }

  /**
   * Звено, которое обёртка уводит в другой каталог (`env -C каталог X`, `pwsh
   * -wd каталог`): судится там, как `( cd каталог; X )`, — иначе затирание вне
   * копии шло бы как своё, со снимком не того дерева (ревью 23.10, R-04).
   */
  inDir<T>(dir: Word | undefined, run: () => T): T {
    if (!dir) return run();
    this.enter();
    try {
      this.changeDir(this.expand(dir));
      return run();
    } finally {
      this.leave();
    }
  }

  /** `ИМЯ=значение` в самой оболочке; `undefined` — значение не проследить. */
  assign(name: string, value: Word | undefined): void {
    if (steersGit(name)) this.gitEnv = true;
    if (this.track(name, value)) return;
    if (!value) {
      this.vars.set(name, undefined);
      return;
    }
    if (/^\$(!|\{!\})$/.test(value.text) && !value.literalDollar) {
      this.vars.set(name, this.childMark);
      return;
    }
    const ports = value.literalDollar ? undefined : this.portQuery(value);
    if (ports) {
      this.vars.set(name, `${this.portMark}${ports.join(',')}`);
      return;
    }
    const made = this.mktemp(value);
    if (made !== false) {
      this.vars.set(name, made);
      return;
    }
    const expanded = this.expand(value);
    this.vars.set(name, expanded.dynamic ? undefined : expanded.text);
    // Пробел внутри `$(…)` или `${…}` — не граница слов значения: такое не разбиваем.
    if (/\s/.test(value.text) && !/\$[({]|`/.test(value.text)) {
      this.split.set(name, this.pieces(value));
    }
  }

  /** Порты, держателей которых напечатает подстановка-слово (`port-query.ts`). */
  portQuery(word: Word): number[] | undefined {
    if (!word.dynamic || this.blinded) return undefined;
    return portQueryPorts(word.text, (name) => this.loops.get(name));
  }

  /** Порты слова-цели погашения: метка из переменной или сама подстановка. */
  portsOf(word: Word): number[] | undefined {
    return portMarkPorts(word.text, this.portMark) ?? this.portQuery(word);
  }

  /** Слова значения, как их даст `$ИМЯ` без кавычек: части с подстановкой — раскрытые сейчас. */
  private pieces(value: Word): Word[] {
    return value.text
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => {
        if (!value.dynamic || !/[$`\\%{}*?[~]/.test(text)) return { text, dynamic: false };
        const expanded = value.literalDollar ? undefined : this.expand({ text, dynamic: true });
        // Разбитое слово уже не раскрывается ещё раз: неизвестное так и остаётся
        // неизвестным (и `L="$L x"` не зациклит суд).
        return expanded && !expanded.dynamic
          ? expanded
          : { text, dynamic: true, literalDollar: true };
      });
  }

  /**
   * Слово с `$ИМЯ` переменных, заданных в этой же команде, — буквально:
   * `S=.agent/tmp/x; rm -rf $S` удаляет временное, а не «неизвестно что».
   * `$(git branch --show-current)` — текущая ветка копии. Прочие подстановки,
   * `~`, `\` и неизвестные переменные оставляют слово неизвестным; после
   * конструкции, которую обход не моделирует (`blind`), — любые переменные.
   */
  expand(word: Word): Word {
    if (!word.dynamic || word.literalDollar || word.fed !== undefined) return word;
    let text = word.text;
    const branch = this.branchAt(this.cwd);
    if (branch) text = text.replace(CURRENT_BRANCH, branch);
    // `~` в начале слова и после `=`/`:` — домашний каталог; `RUSYAN~1` — буква.
    if (/[`\\%]|\$\(|(^|[=:])~/.test(text) || BRACES.test(text)) return word;
    let known = true;
    const value = (name: string): string => {
      const found = this.visible(name) ? this.vars.get(name) : undefined;
      // Пробел в значении без кавычек разобьёт слово; в `"$N"` — одно слово (R-C06).
      if (found === undefined || (!word.unsplit && /\s/.test(found))) known = false;
      return found ?? '';
    };
    // `${D:-build}` при известном `D`: пустое — запасное слово, иначе само значение.
    const expanded = text
      .replace(DEFAULTED, (_match, name: string, colon: string, fallback: string) => {
        const found = value(name);
        return colon && found === '' ? fallback : found;
      })
      .replace(VARIABLE, (_match, braced?: string, bare?: string) =>
        value((braced ?? bare) as string),
      );
    if (!known || expanded.includes('$')) return word;
    // `"$d/../x"` от свежего `mktemp` — уже не он, а соседнее во временном каталоге.
    if (this.isMarked(expanded) && UP.test(expanded)) return word;
    return { text: expanded, dynamic: false };
  }

  inCopy(path: string | undefined): boolean {
    // Через ссылку этой команды (`cd .agent/tmp/l`) — куда угодно, не своя копия (RF-BGCD-04).
    if (!path || this.links.crosses(path, true)) return false;
    return this.variants(path).some((variant) => this.roots.some((root) => within(variant, root)));
  }

  isCopyRoot(path: string): boolean {
    return this.variants(path).some((variant) => this.roots.includes(variant));
  }

  /** Своя рабочая папка CLI этой сессии (`scope.scratchpad`) или внутри неё. */
  inOwnScratchpad(path: string, follow = true): boolean {
    if (this.scratchpad === undefined || !within(path, this.scratchpad)) return false;
    // Ссылка внутри неё, заведённая раньше, ведёт наружу (RF-BGCD-04).
    return !escapesBase(path, this.scratchpad, follow);
  }

  /** Корень копии, под которым лежит путь (в том написании, в каком совпал). */
  rootOf(path: string): { path: string; root: string } | undefined {
    for (const variant of this.variants(path)) {
      const root = this.roots.find((entry) => within(variant, entry));
      if (root) return { path: variant, root };
    }
    return undefined;
  }

  /**
   * Путь вне копии, но под её предком: часть ниже общего предка с корнем копии
   * (`…/worktrees/.agent/tmp/x` → `.agent/tmp/x`). `undefined` — общего нет.
   */
  belowAncestor(path: string): string | undefined {
    const parts = path.split('/');
    for (const root of this.roots) {
      const rootParts = root.replace(/\/$/, '').split('/');
      let common = 0;
      while (common < rootParts.length && parts[common] === rootParts[common]) common += 1;
      if (common > 1 && common < rootParts.length) return parts.slice(common).join('/');
    }
    return undefined;
  }

  private variants(path: string): string[] {
    return [path, real(path)].filter((entry): entry is string => Boolean(entry));
  }

  /** Текущая ветка там, где исполняется звено, — или `undefined`, если не своя копия. */
  branchAt(cwd: string | undefined): string | undefined {
    return this.inCopy(cwd) ? this.branch : undefined;
  }

  /**
   * Своя копия с точно отсоединённой головой — ветка, в которую ляжет слияние,
   * если отсоединение не вышло. Вышло — слияние двигает только HEAD.
   */
  detachedFromAt(cwd: string | undefined): string | undefined {
    return this.inCopy(cwd) ? this.detachedFrom : undefined;
  }

  /** Своя ветка группы там, где исполняется звено, — если её не сменили в этой команде. */
  ownBranchAt(cwd: string | undefined): string | undefined {
    return this.inCopy(cwd) && !this.switched ? this.own : undefined;
  }

  /** Своя ветка группы — та, с которой копия пришла, или текущая после смены в этой команде. */
  isOwnBranch(name: string): boolean {
    return name === this.own || name === this.branch;
  }

  /**
   * HEAD своей копии встала на другое: `checkout`/`switch` (`checkedOut`),
   * `symbolic-ref HEAD refs/heads/x`, `update-ref --no-deref HEAD …` (RF-BGCD-02).
   */
  moveHead(next: ReturnType<typeof checkedOut>, cwd: string | undefined): void {
    if (!this.inCopy(cwd) || next === 'unchanged') return;
    const from = this.detachedFrom ?? this.branch;
    this.switched = true;
    this.detachedFrom = next === DETACHED ? from : undefined;
    this.branch = next === DETACHED ? undefined : next;
  }

  /**
   * `trap '…' EXIT`: обработчик исполнится при выходе — судится тогда, с
   * состоянием конца команды, а не объявления (F-02: `D=.agent/tmp/x; trap
   * 'rm -rf "$D"' EXIT; D=/c/Users/me`).
   */
  defer(script: string): void {
    this.deferred.push({ script, blind: this.depth > 0 });
  }

  /** Отложенные обработчики — раз, в конце разбора. */
  takeDeferred(): Deferred[] {
    return this.deferred.splice(0);
  }
}

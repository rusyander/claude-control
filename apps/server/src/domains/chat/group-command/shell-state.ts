import type { Word } from './shell-parse.ts';
import { LinkLedger } from './links.ts';
import { canonical, within } from './paths.ts';

/**
 * Состояние оболочки при обходе команды: каталог, переменные, их экспорт и то,
 * что обход проследить не может. Вынесено из `walk.ts` (ревью 23.10, F-03,
 * F-16): ребёнок `bash -c` видит только экспортированное, а после `IFS=`,
 * `source`, тела функции значения переменных и каталог уже не известны.
 */

/**
 * `$(mktemp)`, `$(mktemp -d)`, `$(mktemp -t x.XXXX)` — новый файл во временном
 * каталоге системы. С шаблоном-путём (`mktemp ./x.XXXX`) — уже не он.
 */
const MKTEMP =
  /^\$\(mktemp(?:\s+(?:-[dqu]+|--(?:directory|quiet|dry-run|tmpdir)|-t|-p\s+\/tmp|--suffix=[\w.-]+))*(?:\s+(?:[\w.-]*X{3,}[\w.-]*|"?(?:\$\{TMPDIR:-\/tmp\}|\$\{TMPDIR\}|\$TMPDIR|\/tmp)\/[\w.-]*X{3,}[\w.-]*"?))?\)$/;
/** `mktemp -d`, `mktemp --directory` — каталог, а не файл. */
const MKTEMP_DIR = /\s(?:-[qu]*d[dqu]*|--directory)(?=\s|\))/;

/**
 * Окружение, которое подгружает чужой код в каждую следующую программу, в том
 * числе во встроенные проверки оболочки (F-15): `LD_PRELOAD`, `BASH_ENV`.
 */
export const CODE_ENV =
  /^(LD_\w+|DYLD_\w+|BASH_ENV|ENV|PERL5OPT|PERL5LIB|RUBYOPT|PYTHONSTARTUP|PROMPT_COMMAND|PS4)$/;

/**
 * Присваивание меняет, что и как исполнят следующие программы. Не входят
 * (владелец 23.10, группы — как авторежим VS Code):
 * - `PATH` — меняет лишь то, какой файл найдётся по имени, а свою программу
 *   группа и так вправе запустить прямо (`./bin/ls`, `bash x.sh`):
 *   `export PATH="/c/Program Files/nvm/…:$PATH" && node -v` — настройка
 *   инструментов, следующие команды судятся по своим именам;
 * - `NODE_OPTIONS=--require …` — то же, что `node -r файл`, которое уже
 *   «прочее» (F-07): журнал проверок панели подгружается так в каждый `node`.
 */
export function steersNames(name: string): boolean {
  return CODE_ENV.test(name);
}

export interface Frame {
  cwd: string | undefined;
  anchored: boolean;
  guessed: boolean;
  gitEnv: boolean;
  vars: Map<string, string | undefined>;
  exported: Set<string>;
  exportAll: boolean;
  cdpath: boolean;
  blinded: boolean;
  namesUnknown: boolean;
  dotglob: boolean;
  loops: Map<string, string[]>;
  split: Map<string, Word[]>;
}

/** Слово — одна переменная целиком: `$T`, `${T}`. */
const WHOLE_VARIABLE = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/;
const REFERENCE = /\$\{?([A-Za-z_]\w*)/g;
/** Больше значений цикла звено не перебирает: дальше значение неизвестно. */
const MAX_LOOP_VALUES = 32;

export class ShellState {
  /** Каталог звена; `undefined` — ушли туда, куда не проследить. */
  cwd: string | undefined;
  /**
   * Каталог известен точно: `cd` по абсолютному пути. Без него оболочка агента
   * могла остаться в подкаталоге копии после прошлой команды — CLI хранит каталог
   * между вызовами, а запрос прав его не несёт.
   */
  anchored = false;
  /**
   * Каталог взят наугад — корень копии, потому что каталога оболочки CLI нет
   * (F-29): относительное невременное удаление тогда решает человек.
   */
  guessed = false;
  /** В оболочке задано окружение git (`GIT_DIR`, `GIT_WORK_TREE`): куда пойдёт git — не проследить. */
  gitEnv = false;
  /**
   * Дальше переменные не проследить (F-16): `IFS=` режет значения по-своему,
   * `source`, тело функции, `declare -n` меняют их незаметно для обхода.
   */
  blinded = false;
  /** Задан `CDPATH`: `cd имя` уйдёт в его каталог, а не в подкаталог. */
  cdpath = false;
  /** `LD_PRELOAD`, `BASH_ENV`, `enable` сменили, что исполнится по имени команды. */
  namesUnknown = false;
  /** `shopt -s dotglob`: `*` находит и `.git`. */
  dotglob = false;
  /** `set -a`: каждое присваивание экспортируется. */
  exportAll = false;
  /** Переменные оболочки: значение или `undefined` — задана, но значение неизвестно. */
  protected vars = new Map<string, string | undefined>();
  /** Экспортированные имена: только их получит ребёнок `bash -c` (F-03). */
  protected exported = new Set<string>();
  /**
   * Переменные цикла `for x in a b c` со списком из известных слов: звено,
   * где они стоят, судится по разу на каждое значение.
   */
  protected loops = new Map<string, string[]>();
  /**
   * Значения с пробелами, разбитые на слова в момент присваивания: `$L` без
   * кавычек оболочка разобьёт так же. Слово с неизвестной частью
   * (`L="node $HOME/x.mjs"`) — неизвестное, но имя команды `node` известно.
   */
  protected split = new Map<string, Word[]>();
  /** Переменные с одним значением на всю команду (`stable.ts`): известны и вслепую. */
  stable: ReadonlySet<string> = new Set();
  /**
   * Глубина разбора строк-аргументов чужой программы как сценария (`ssh host
   * '…'`): там ищутся удаление, git и погашение; неизвестное имя команды в
   * прозе (`$1`, `**Create`) само по себе карточкой не становится.
   */
  prose = 0;
  /**
   * Значения `$(mktemp …)` этой команды: каталог (`-d`) или файл. Имя несёт
   * метку обхода, которую не написать руками: `cd /tmp/…` словами свежим
   * каталогом не станет.
   */
  private readonly fresh = new Map<string, 'dir' | 'file'>();
  /** Ссылки, заведённые этой командой (`links.ts`): ниже них — не временное и не своё. */
  readonly links = new LinkLedger();
  private readonly mark = `mktemp.${Math.random().toString(36).slice(2)}`;
  /** Оболочка снаружи подоболочек и подстановок: `cd` и переменные внутри наружу не выходят. */
  private readonly outer: Frame[] = [];
  /** Каталоги `pushd`. */
  private readonly stack: { cwd: string | undefined; anchored: boolean }[] = [];

  /** Глубина подоболочек и подстановок сейчас. */
  get depth(): number {
    return this.outer.length;
  }

  protected frame(): Frame {
    return {
      cwd: this.cwd,
      anchored: this.anchored,
      guessed: this.guessed,
      gitEnv: this.gitEnv,
      vars: new Map(this.vars),
      exported: new Set(this.exported),
      exportAll: this.exportAll,
      cdpath: this.cdpath,
      blinded: this.blinded,
      namesUnknown: this.namesUnknown,
      dotglob: this.dotglob,
      loops: new Map(this.loops),
      split: new Map(this.split),
    };
  }

  /** Подоболочка `( … )`, `$( … )`, фон, звено трубы: видит всё, наружу не выносит. */
  enter(): void {
    this.outer.push(this.frame());
  }

  /**
   * Новый процесс оболочки (`bash -c`): видит только экспортированные
   * переменные и окружение префикса (`X=… bash -c`), а не все переменные
   * родителя (F-03: `X=.agent/tmp/x; bash -c 'rm -rf "$X/c/Users/me"'`).
   */
  enterChild(prefix: ReadonlyMap<string, string | undefined>): void {
    this.enter();
    const vars = new Map<string, string | undefined>();
    for (const [name, value] of this.vars) {
      if (this.exportAll || this.exported.has(name)) vars.set(name, value);
    }
    for (const [name, value] of prefix) vars.set(name, value);
    this.vars = vars;
    this.exported = new Set(vars.keys());
    this.exportAll = false;
    // Переменная цикла и разбитое значение доходят до ребёнка, только если экспортированы.
    const inherited = <T>(map: Map<string, T>): Map<string, T> =>
      new Map([...map].filter(([name]) => vars.has(name) && !prefix.has(name)));
    this.loops = inherited(this.loops);
    this.split = inherited(this.split);
  }

  leave(): void {
    const state = this.outer.pop();
    if (!state) return;
    this.cwd = state.cwd;
    this.anchored = state.anchored;
    this.guessed = state.guessed;
    this.gitEnv = state.gitEnv;
    this.vars = state.vars;
    this.exported = state.exported;
    this.exportAll = state.exportAll;
    this.cdpath = state.cdpath;
    this.blinded = state.blinded;
    this.namesUnknown = state.namesUnknown;
    this.dotglob = state.dotglob;
    this.loops = state.loops;
    this.split = state.split;
  }

  /**
   * Дальше обход не знает значений переменных; `cwd` — и каталога (тело
   * функции исполнится там, где её вызовут; `source` может сделать `cd`).
   */
  blind(cwd = true): void {
    this.blinded = true;
    if (!cwd) return;
    this.cwd = undefined;
    this.anchored = false;
  }

  /** `pushd` — как `cd`, с возвратом по `popd`. */
  pushDir(dir: Word | undefined): void {
    this.stack.push({ cwd: this.cwd, anchored: this.anchored });
    this.changeDir(dir);
  }

  popDir(): void {
    const top = this.stack.pop();
    this.cwd = top?.cwd;
    this.anchored = top?.anchored ?? false;
  }

  /** `cd` — у `Walk`: ему нужен корень копии. */
  changeDir(dir: Word | undefined): void {
    void dir;
    this.cwd = undefined;
  }

  unset(name: string): void {
    this.vars.set(name, undefined);
    this.loops.delete(name);
    this.split.delete(name);
  }

  /**
   * `for ИМЯ in слова…`: известные слова — значения, которые звенья тела
   * переберут (`for p in /c/Python314/python /c/Python310/python; do $p -c …`);
   * неизвестные или их слишком много — значение не проследить.
   */
  loop(name: string, values: string[] | undefined): void {
    this.unset(name);
    if (values && values.length > 0 && values.length <= MAX_LOOP_VALUES) {
      this.loops.set(name, values);
    }
  }

  /**
   * Сколько раз судить звено: по разу на значение переменной цикла, которая в
   * нём стоит (одна; две и больше — значения не перебираются). Значение
   * ставится на время суда и снимается после.
   */
  eachValue(texts: string[], run: () => void): void {
    const names = new Set<string>();
    if (!this.blinded) {
      for (const text of texts) {
        for (const match of text.matchAll(REFERENCE)) {
          if (this.loops.has(match[1] as string)) names.add(match[1] as string);
        }
      }
    }
    const [name] = names;
    const values = name !== undefined && names.size === 1 ? this.loops.get(name) : undefined;
    if (!name || !values) {
      run();
      return;
    }
    for (const value of values) {
      this.vars.set(name, value);
      // `for v in "A=1 B=2"; do env $v …`: значение разобьётся на слова.
      const words = value.split(/\s+/).filter(Boolean);
      if (/\s/.test(value))
        this.split.set(
          name,
          words.map((text) => ({ text, dynamic: false })),
        );
      run();
      this.split.delete(name);
    }
    this.vars.set(name, undefined);
  }

  /**
   * Слова значения с пробелами, если слово — одна переменная целиком:
   * `T="node tools/x.mjs"; $T list` — оболочка разобьёт его на слова.
   */
  spacedValue(word: Word): Word[] | undefined {
    // `"$T"` в кавычках оболочка не разбивает: одно слово с пробелами.
    if (!word.splits || word.literalDollar) return undefined;
    const match = WHOLE_VARIABLE.exec(word.text);
    const name = (match?.[1] ?? match?.[2]) as string | undefined;
    return name && this.visible(name) ? this.split.get(name) : undefined;
  }

  /** Значение переменной видно обходу: не вслепую или оно одно на всю команду. */
  protected visible(name: string): boolean {
    return !this.blinded || this.stable.has(name);
  }

  /** `export ИМЯ`, `declare -x ИМЯ`. */
  export(name: string): void {
    this.exported.add(name);
  }

  /**
   * Имя задано в этой же команде или переменные уже не проследить: `$TMPDIR`
   * тогда — не временный каталог системы (`TMPDIR=$HOME; rm -rf $TMPDIR/src`).
   */
  shadows(name: string): boolean {
    return this.blinded || this.vars.has(name);
  }

  /** Имена, заданные этой командой и видные здесь (окружение git — `git-env.ts`). */
  assignedNames(): string[] {
    return [...this.vars.keys()];
  }

  /**
   * Особые имена: `IFS` режет значения, `CDPATH` уводит `cd`, `LD_PRELOAD`
   * меняет исполняемое. `true` — присваивание уже учтено целиком.
   */
  protected track(name: string, value: Word | undefined): boolean {
    if (this.exportAll) this.exported.add(name);
    // Присвоенное в теле цикла значение заменяет перебор.
    this.loops.delete(name);
    this.split.delete(name);
    if (name === 'IFS') this.blind(false);
    if (name === 'CDPATH') this.cdpath = !value || value.dynamic || value.text !== '';
    if (steersNames(name)) this.namesUnknown = true;
    return false;
  }

  /**
   * `$(mktemp …)`: метка свежего пути; `undefined` — путь не проследить;
   * `false` — значение не `mktemp`.
   */
  protected mktemp(value: Word): string | undefined | false {
    if (!MKTEMP.test(value.text) || value.literalDollar) return false;
    // `TMPDIR` задан в этой же команде — `mktemp` создаст своё там, а не во временном.
    if (this.shadows('TMPDIR')) return undefined;
    return this.freshPath(MKTEMP_DIR.test(value.text) ? 'dir' : 'file');
  }

  /** Новый свежий путь обхода: его не написать руками. */
  freshPath(kind: 'dir' | 'file'): string {
    const made = canonical(`/tmp/${this.mark}.${this.fresh.size}`);
    this.fresh.set(made, kind);
    return made;
  }

  protected isMarked(text: string): boolean {
    return text.includes(this.mark);
  }

  /**
   * Путь — свежий `mktemp` этой команды (файл или каталог) или внутри него.
   * `follow` — действие идёт по самому имени (запись, `rm -rf x/`), см. `LinkLedger.crosses`.
   */
  isFresh(path: string | undefined, follow = true): boolean {
    if (!path || this.links.crosses(path, follow)) return false;
    for (const made of this.fresh.keys()) if (within(path, made)) return true;
    return false;
  }

  /**
   * Каталог — свежий `mktemp -d` этой команды или внутри него: пробный
   * репозиторий там не задевает ни копию, ни чужие данные.
   */
  inScratch(path: string | undefined): boolean {
    if (!path || this.links.crosses(path, true)) return false;
    for (const [made, kind] of this.fresh) if (kind === 'dir' && within(path, made)) return true;
    for (const [made, chain] of this.clones) {
      if (chain === this.chain && within(path, made)) return true;
    }
    return false;
  }

  /** Цепочка `&&` звена, что судится сейчас (`Segment.chain`). */
  private chain: number | undefined;
  /** Каталоги `git clone` этой команды — с номером цепочки, где клон удался. */
  private readonly clones = new Map<string, number>();

  atChain(chain: number | undefined): void {
    this.chain = chain;
  }

  /**
   * Каталог свежего клона — пробный репозиторий, но только дальше по ТОЙ ЖЕ
   * цепочке `&&` (решение 23.10): там клон точно удался, а `git clone` в
   * непустой каталог не идёт — значит, каталог завела эта команда. После `;`,
   * `||`, трубы или `!` клон мог не выйти, и `cd` с `git checkout` попали бы в
   * прежний каталог — например, в копию ветки.
   */
  noteClone(path: string): void {
    if (this.chain !== undefined) this.clones.set(path, this.chain);
  }
}

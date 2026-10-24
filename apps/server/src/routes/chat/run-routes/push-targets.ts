import {
  BLIND,
  ENTER,
  LEAVE,
  UNPARSED,
  parse,
  type Step,
  type Word,
} from '../../../domains/chat/group-command/shell-parse.ts';
import { isProtectedBranch } from '../../../domains/chat/group-command/group-command.ts';
import { steersGit } from '../../../domains/chat/group-command/walk.ts';

/**
 * Куда пишет `git push` — и можно ли это доказать.
 *
 * Зачем отдельно от моста. Слияние и push в main — шаг владельца: такой вызов
 * ОТБИВАЕТСЯ, а не ставится человеку как D-n (решение 2). Пока цель читали
 * грубым разбором по пробелам, мимо проходили обычные формы, которые пишут
 * main: `HEAD:"main"` (кавычки снимались только по краям слова), `HEAD:$B`
 * (переменная оставалась текстом `$B` — и слово «main» не видел даже человек в
 * списке), `--all` и `--mirror` (уносят все ветки, основную тоже), пуш через
 * алиас (`git -c alias.p=push p …`) и шаблон `refs/heads/*:refs/heads/*`
 * (холодное ревью 23.10, D-S02). Все они становились разрешаемым одним щелчком
 * D-n.
 *
 * Поэтому цель судится по НАСТОЯЩЕМУ разбору оболочки (`shell-parse.ts`
 * классификатора групп: кавычки сняты, подстановки помечены `dynamic`), а
 * недоказуемая цель — отказ, не вопрос: «назови ветку явно одним refspec».
 * Умолчание default-deny: неизвестная цель может оказаться main.
 */

/** Цель пуша: ветка по имени, или «доказать нельзя» с причиной для текста отказа. */
export type PushTarget =
  { kind: 'branch'; name: string } | { kind: 'unresolved'; why: UnresolvedPush };

/**
 * Почему цель не доказана. Текст причины уходит агенту (`texts.ts`), поэтому
 * коды короткие и однозначные.
 */
export type UnresolvedPush =
  | 'substitution'
  | 'wildcard'
  | 'all-refs'
  | 'alias'
  | 'push-config'
  | 'other-repo'
  | 'unknown-flag'
  | 'current-branch-unknown'
  | 'invalid-ref'
  | 'unparsed';

/**
 * Чем причина объясняется агенту (по-английски: текст читает модель). Сам текст
 * отказа — `texts.ts` записей D-n, сюда он не тянется: `domains/` не знает о
 * `routes/`.
 */
export const PUSH_UNRESOLVED_CAUSE: Record<UnresolvedPush, string> = {
  substitution: 'the refspec contains a shell substitution, so its target is unknown',
  wildcard: 'the refspec is a pattern, so it can carry the main branch too',
  'all-refs': '--all / --mirror push every local ref, the main branch included',
  alias: 'the push goes through a git alias, which can carry its own refspec',
  'push-config':
    'the command sets a config or GIT_* environment that can redirect the push (push.default, remote.*, branch.*, GIT_CONFIG_*)',
  'other-repo':
    'the push runs in another working copy (-C, --git-dir, GIT_DIR, GIT_WORK_TREE), whose branch the panel does not know',
  'invalid-ref': 'the refspec names a ref git cannot take as written, so its target is unknown',
  'unknown-flag': 'an unrecognised flag may change the destination',
  'current-branch-unknown': 'the panel could not read which branch this copy is on',
  unparsed: 'the command could not be parsed, so its push target is unknown',
};

/** Где стоит копия: ветка по git и ветка по умолчанию у `origin`. */
export interface BranchFacts {
  branch?: string;
  base?: string;
}

/** Ключи `git push` со значением следующим словом — значение не refspec. */
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
/** Глобальные ключи `git` со значением следующим словом. */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
/** Ключи, после которых цель — не ветка, а все ссылки сразу. */
const ALL_REFS_FLAGS = new Set(['--all', '--mirror']);
/** Сам git: `git`, `git.exe`, `/usr/bin/git`. */
const GIT_PROGRAM = /(?:^|[\\/])git(?:\.exe)?$/i;
/** Алиас, разложенный в самой команде: `-c alias.p=push`, `-c alias.p=push --mirror`. */
const ALIAS_SETTING = /^alias\.([^=]+)=(.*)$/i;
/** Ключ, несущий настройку: `-c k=v`, `--config=k=v`, `--config-env=k=ПЕРЕМЕННАЯ`. */
const CONFIG_INLINE = /^--config(?:-env)?=(.*)$/;
/**
 * Настройка, меняющая цель пуша БЕЗ refspec: `push.default` чего-либо кроме
 * `current`/`simple` шлёт ветку вверх по upstream или все одноимённые
 * (`matching`), а `remote.X.push` задаёт свой refspec по умолчанию. Обе формы
 * уносят main с ветки, которая main не называется (D-S02).
 */
const PUSH_REDIRECT =
  /^(?:push\.default(?!=(?:current|simple)$)|remote\.|branch\.[^=]*\.(?:pushremote|merge|remote)=|url\.[^=]*\.pushinsteadof=)/i;
/**
 * Окружение, которое git читает как ключи (RF-DS-06, повторное ревью 24.10):
 * `GIT_DIR=… git push` — тот же `--git-dir=`, `GIT_CONFIG_COUNT/KEY/VALUE` —
 * тот же `-c`. Какие имена правят git, знает классификатор групп (`steersGit`);
 * из них эти уводят в другую копию, прочие — настройка, менявшая бы цель.
 */
const ELSEWHERE_ENV =
  /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i;
/** Присваивание окружения словом: `NAME=…`, PowerShell `$env:NAME=…`. */
const ENV_ASSIGNMENT = /^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=/i;
/**
 * Имя ветки, которое git как имя ссылки не примет: пробел и управляющие знаки,
 * `~^?[\`, `..`, `@{`, конец на `.`, `/` или `.lock`. Сравнить его с main
 * нельзя, а что git сделает с ним после правки руками — неизвестно.
 */
const INVALID_REF_TEXT = /[\s~^?[\\]|\.\.|@\{|[./]$|\.lock$/;
/** Управляющие знаки (0x00–0x1f, 0x7f) — по кодам: литерал в регулярке запрещён линтером. */
function invalidRef(name: string): boolean {
  if (INVALID_REF_TEXT.test(name)) return true;
  return [...name].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}
/** Ключи, уводящие git в ДРУГУЮ копию: прочитанная здесь ветка о ней ничего не говорит. */
const ELSEWHERE_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);
const ELSEWHERE_INLINE = /^--(?:git-dir|work-tree)=/;

/** Имя ветки на удалённом: `refs/heads/x` и `heads/x` (DWIM `refs/%s`) — это `x`. */
function branchName(ref: string): string {
  for (const prefix of ['refs/heads/', 'heads/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

/**
 * Одна подкоманда git со своими словами; `alias` — пуш пришёл через алиас,
 * `redirects` — в команде настройка, меняющая цель пуша, `elsewhere` — git
 * увели в другую копию.
 */
interface GitCall {
  verb: string;
  args: Word[];
  alias: boolean;
  redirects: boolean;
  elsewhere: boolean;
}

/**
 * Подкоманды git в одном звене. Глобальные ключи пропускаются; `-c alias.X=push`
 * запоминается, и дальше слово `X` — это тоже пуш (через алиас). Настройка и
 * чужой каталог из тех же ключей запоминаются для суждения о цели.
 */
function gitCalls(words: readonly Word[]): GitCall[] {
  const calls: GitCall[] = [];
  const pushAliases = new Set<string>();
  const starts: number[] = [];
  for (let at = 0; at < words.length; at += 1) {
    if (GIT_PROGRAM.test(words[at]?.text ?? '')) starts.push(at);
  }
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? words.length;
    let verb = start + 1;
    let redirects = false;
    let elsewhere = false;
    while (verb < end && (words[verb]?.text ?? '').startsWith('-')) {
      const flag = words[verb]?.text ?? '';
      const inline = CONFIG_INLINE.exec(flag)?.[1];
      const config = flag === '-c' || inline !== undefined;
      const holder = flag === '-c' ? words[verb + 1] : words[verb];
      const value = flag === '-c' ? (holder?.text ?? '') : (inline ?? '');
      const alias = ALIAS_SETTING.exec(value);
      // `alias.p=push`, `alias.p=!git push …` — слово `p` дальше значит пуш.
      if (alias && /(?:^|[\s!])(?:git\s+)?push\b/.test(alias[2] ?? '')) {
        pushAliases.add(alias[1] ?? '');
      }
      // Настройка из подстановки (`-c "$CFG"`) могла быть любой, в том числе
      // `push.default=matching`: что она меняет, доказать нельзя.
      if (config && (PUSH_REDIRECT.test(value) || holder?.dynamic)) redirects = true;
      if (ELSEWHERE_FLAGS.has(flag) || ELSEWHERE_INLINE.test(flag)) elsewhere = true;
      verb += GIT_VALUE_FLAGS.has(flag) ? 2 : 1;
    }
    const name = words[verb]?.text ?? '';
    calls.push({
      verb: pushAliases.has(name) ? 'push' : name,
      args: words.slice(verb + 1, end),
      alias: pushAliases.has(name),
      redirects,
      elsewhere,
    });
  }
  return calls;
}

/**
 * Цели одного `git push`. Пустой список — пуш тут не узнан; иначе каждая цель
 * либо названа, либо «доказать нельзя».
 */
export function pushTargets(args: readonly Word[], facts: BranchFacts): PushTarget[] {
  const unresolved = (why: UnresolvedPush): PushTarget[] => [{ kind: 'unresolved', why }];
  const positional: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (!word) continue;
    // Подстановка в любом слове пуша: что уедет — неизвестно, в том числе main.
    if (word.dynamic) return unresolved('substitution');
    const text = word.text;
    if (ALL_REFS_FLAGS.has(text)) return unresolved('all-refs');
    if (PUSH_VALUE_FLAGS.has(text)) {
      at += 1;
      continue;
    }
    if (text.startsWith('-')) continue;
    positional.push(text);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) {
    // Без refspec git шлёт текущую ветку: не прочитали её — цель недоказуема.
    return facts.branch
      ? [{ kind: 'branch', name: facts.branch }]
      : unresolved('current-branch-unknown');
  }
  const targets: PushTarget[] = [];
  for (const refspec of refspecs) {
    if (refspec.includes('*')) return unresolved('wildcard');
    const bare = refspec.replace(/^\+/, '');
    const parts = bare.split(':');
    // `src:dst:ещё` — не refspec; что это, не судим.
    if (parts.length > 2) return unresolved('wildcard');
    const source = parts[0] ?? '';
    const destination = parts.length === 2 ? (parts[1] ?? '') : source;
    // «main » с пробелом git отвергнет, а сравнение с main его пропустило бы.
    if (invalidRef(destination || source)) return unresolved('invalid-ref');
    // `:ветка` — удаление ветки на удалённом; цель та же ветка.
    const named = branchName(destination || source);
    if (named === 'HEAD' || named === '@') {
      // Приёмник `HEAD` — ветка по умолчанию удалённого (main); источник `HEAD`
      // без приёмника — своя ветка.
      const own = parts.length === 2 ? facts.base : facts.branch;
      if (!own) return unresolved('current-branch-unknown');
      targets.push({ kind: 'branch', name: own });
      continue;
    }
    targets.push({ kind: 'branch', name: named });
  }
  return targets;
}

/** Итог по команде: пишет защищённую ветку, или цель недоказуема, или ни то ни другое. */
export type PushVerdict =
  { kind: 'protected'; target: string } | { kind: 'unresolved'; why: UnresolvedPush } | undefined;

/** Слова звеньев разобранной команды; подстановки внутри `$(…)` тоже звенья. */
function segmentsOf(command: string): Word[][] | undefined {
  const steps = parse(command);
  if (steps === UNPARSED) return undefined;
  const list: Word[][] = [];
  for (const step of steps as Step[]) {
    if (step === ENTER || step === LEAVE || step === BLIND) continue;
    list.push(step.words);
  }
  return list;
}

/** Слова команды чужой оболочки (PowerShell): грубо, зато с пометкой подстановки. */
function roughWords(command: string): Word[][] {
  return [
    command
      .split(/[\s;&|()]+/)
      .filter(Boolean)
      .map((text) => ({
        text: text.replace(/^["']|["']$/g, ''),
        dynamic: /[$%]/.test(text),
      })),
  ];
}

/**
 * Пишет ли команда в защищённую ветку — и можно ли это доказать. Локальный
 * `git merge` В защищённую ветку (копия на ней или переключена на неё той же
 * командой) — тот же итог: слияние в main.
 */
export function pushVerdictOf(command: string, facts: BranchFacts, posix = true): PushVerdict {
  const segments = posix ? segmentsOf(command) : roughWords(command);
  // Команда не разобрана: есть ли в ней пуш, неизвестно — судим по тексту.
  if (!segments) {
    return /\bgit\b[^\n]*\bpush\b/.test(command)
      ? { kind: 'unresolved', why: 'unparsed' }
      : undefined;
  }
  let branch = facts.branch;
  // Окружение копится по ходу команды: `export GIT_DIR=…; git push` — тоже оно.
  const steer = { elsewhere: false, redirects: false };
  for (const words of segments) {
    const firstGit = words.findIndex((word) => GIT_PROGRAM.test(word.text));
    for (const word of firstGit < 0 ? words : words.slice(0, firstGit)) {
      const name = ENV_ASSIGNMENT.exec(word.text)?.[1];
      if (!name || !steersGit(name)) continue;
      if (ELSEWHERE_ENV.test(name)) steer.elsewhere = true;
      else steer.redirects = true;
    }
    for (const found of gitCalls(words)) {
      const call = {
        ...found,
        elsewhere: found.elsewhere || steer.elsewhere,
        redirects: found.redirects || steer.redirects,
      };
      if (call.verb === 'push') {
        // Алиас мог нести свои ключи (`alias.p=push --mirror`): цель недоказуема.
        if (call.alias) return { kind: 'unresolved', why: 'alias' };
        // `-c push.default=upstream` уносит ветку в main, сама так не называясь.
        if (call.redirects) return { kind: 'unresolved', why: 'push-config' };
        const here = { ...facts, ...(branch ? { branch } : {}) };
        // `git -C ../основная push` шлёт ветку ДРУГОЙ копии: наша ничего о ней
        // не говорит, а той копией вполне может быть main.
        const known = call.elsewhere ? (facts.base ? { base: facts.base } : {}) : here;
        const targets = pushTargets(call.args, known);
        for (const target of targets) {
          if (target.kind === 'unresolved') {
            return target.why === 'current-branch-unknown' && call.elsewhere
              ? { kind: 'unresolved', why: 'other-repo' }
              : target;
          }
          if (isProtectedBranch(target.name, facts.base)) {
            return { kind: 'protected', target: target.name };
          }
        }
        continue;
      }
      // Переключение той же командой: `git checkout main && git merge x`.
      if (call.verb === 'checkout' || call.verb === 'switch') {
        const named = call.args.filter((word) => !word.text.startsWith('-'));
        if (named.length === 1 && named[0] && !named[0].dynamic) branch = named[0].text;
      }
      if (call.verb === 'merge' && branch && isProtectedBranch(branch, facts.base)) {
        return { kind: 'protected', target: branch };
      }
    }
  }
  return undefined;
}

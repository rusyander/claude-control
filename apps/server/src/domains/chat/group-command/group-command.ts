import { assign, assignedValue, assignments, builtinVerdict } from './builtins.ts';
import { codeVerdict } from './code.ts';
import { findVerdict } from './find.ts';
import { FORGE_CLI, HTTP_CLI, forgeVerdict, wrapped } from './foreign.ts';
import { fedVerdict, foreignVerdict, type Judges } from './foreign-walk.ts';
import { gitEnvRuns, steeredGitVerdict } from './git-env.ts';
import { gitVerdict } from './git-verdict.ts';
import { isKiller, killsProcess } from './kill.ts';
import { awkVerdict, isProgram, sedVerdict } from './programs.ts';
import { isStdinShell, readerRuns, readsInputAsData, readsOnly, runsInput } from './readers.ts';
import { risky } from './risky.ts';
import {
  BLIND,
  ENTER,
  LEAVE,
  parse,
  UNPARSED,
  type Segment,
  type Step,
  type Word,
} from './shell-parse.ts';
import {
  SCRIPT_PATH,
  SHELL_BUILTINS,
  commandName,
  harmlessRedirect,
  killSegment,
  knownOutput,
  printed,
  teeVerdict,
} from './segment-parts.ts';
import { steersNames } from './shell-state.ts';
import { stableNames } from './stable.ts';
import { Tally, type GroupCommandVerdict } from './tally.ts';
import { isRemover, removeVerdict } from './targets.ts';
import {
  DANGER,
  OTHER,
  ROUTINE,
  Walk,
  isAbsolute,
  steersGit,
  type GroupCommandScope,
  type SegmentVerdict,
} from './walk.ts';
import { unpackPaths } from './extract.ts';
import { linkPaths } from './links.ts';
import { aliasScript, chainsAlias, riskyFunctionBody } from './alias-script.ts';
import { isMake, makeVerdict } from './make.ts';
import { resolveFrom } from './paths.ts';
import {
  isInterpreter,
  unwrap,
  xargsCommand,
  type ScriptScope,
  type Unwrapped,
} from './wrappers.ts';
import { powershellNamesStorage, redirectOutside, writesVerdict } from './writes.ts';

export type { GroupCommandScope } from './walk.ts';
export type { CodeRule } from './risky.ts';
export type { KillTargets } from './kill.ts';
export type { GroupCommandVerdict } from './tally.ts';
export { ignoredFacts } from './targets.ts';
export { isProtectedBranch } from './walk.ts';

/**
 * Разбор команды оболочки группы разделения. Классификатор чата (`ruleFor`)
 * смотрит на текст регулярками и видит `--force` в `--force-with-lease`, «drop»
 * в сообщении коммита, а составную `cd <копия> && git push … 2>&1 | tail -5` не
 * узнавал вовсе.
 *
 * Политика владельца 19.10: карточка спрашивает человека ТОЛЬКО про удаление
 * (ветки локально и на удалённом, метки, копии, настоящие файлы и каталоги,
 * таблицы и базы), слияние (`git merge`, слияние MR через API или CLI форджа),
 * пуш в основную или защищённую ветку и принудительный пуш. Всё прочее
 * решается само; обычный пуш рабочей ветки — тоже. 23.10: «все безопасные
 * команды — сами»: переменные, обёртки, удаление своего в копии.
 *
 * Здесь команда разбирается на звенья с кавычками, подстановками и heredoc, и
 * каждое звено узнаётся по устройству, а не по словам:
 * - `routine` — вся команда из рутины группы (`cd` в свою копию, add, commit,
 *   fetch, rebase на origin/main, stash, пуш рабочей ветки, уборка временного,
 *   чтение и сверка, запись во временный файл);
 * - `danger` — в команде есть то, что решает человек при любых строках;
 * - `other` — прочее; правила чата судят ТОЛЬКО тексты таких звеньев (`texts`):
 *   «drop» в `grep` или в теле `cat > x.sql <<EOF` их больше не касается.
 *
 * Своя ветка приходит снаружи — прочитанной у git копии (`group-permissions.ts`),
 * и никогда не берётся из текста команды.
 */

type Env = ReadonlyMap<string, string | undefined>;
const NO_ENV: Env = new Map();

/**
 * Сценарий из обёртки. `same` — в этой же оболочке; `child` — новый процесс:
 * только экспортированное и окружение префикса (F-03); `deferred` — при выходе
 * (F-02); `blind` — когда и где, не проследить (`alias`).
 */
function scriptVerdict(
  script: string,
  scope: ScriptScope,
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  if (scope === 'deferred') {
    walk.defer(script);
    return ROUTINE;
  }
  const steps = parse(script);
  // Погашение в сценарии, который не разобрать, — цель не назвать (N3).
  if (steps === UNPARSED) return risky(script) || killsProcess(script) ? DANGER : OTHER;
  if (scope === 'child') walk.enterChild(env);
  else if (scope === 'blind') {
    walk.enter();
    walk.blind();
  }
  judge(steps, walk, tally);
  if (scope !== 'same') walk.leave();
  return ROUTINE;
}

function unwrappedVerdict(
  unwrapped: Unwrapped,
  words: Word[],
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  switch (unwrapped.kind) {
    case 'reader':
      return ROUTINE;
    case 'danger':
      return DANGER;
    case 'command':
      return walk.inDir(unwrapped.cwd, () =>
        commandVerdict(unwrapped.words, walk, tally, false, env),
      );
    case 'code':
      return codeVerdict(unwrapped.code, words, walk);
    case 'script':
      return scriptVerdict(unwrapped.script, unwrapped.scope, walk, tally, env);
    case 'find':
      return findVerdict(unwrapped.find, walk, (inner) =>
        commandVerdict(inner, walk, tally, false, env),
      );
  }
}

/** Суд звена и шагов для модулей, которым нужен обход вложенного (`foreign-walk.ts`). */
function judgesFor(walk: Walk): Judges {
  return {
    command: (words, tally) => commandVerdict(words, walk, tally, false, NO_ENV),
    steps: (steps, tally) => judge(steps, walk, tally),
  };
}

/**
 * `T="node tools/x.mjs"; $T list`: оболочка разобьёт известное значение на
 * слова (без кавычек и подстановок внутри — они остаются буквами). Раньше
 * такое имя считалось неизвестным, и звено шло человеку.
 */
/**
 * Имя команды — псевдоним из снимка оболочки CLI (раунд 10): судится развёртка,
 * как её исполнит оболочка, — `gp origin main --force` с `alias gp='git push'`
 * это `git push origin main --force`. Развёртка из нескольких звеньев (`a && b`),
 * с перенаправлением или с пробелом в конце судится текстом вместе со словами
 * вызова (`alias-script.ts`), как её склеит оболочка, и звено идёт правилами
 * чата (`OTHER`), если развёртка не опасна.
 */
function aliasVerdict(
  name: string,
  value: string,
  raw: Word[],
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  const steps = parse(value);
  const only = steps !== UNPARSED && steps.length === 1 ? steps[0] : undefined;
  const aliases = walk.aliases ?? {};
  walk.expanding.add(name);
  try {
    const plain =
      typeof only === 'object' && only.redirects.length === 0 && only.inputs.length === 0;
    if (plain && !chainsAlias(value, raw[1], aliases)) {
      return commandVerdict([...only.words, ...raw.slice(1)], walk, tally, false, env);
    }
    const script = aliasScript(value, raw.slice(1), aliases, walk.expanding);
    const body = scriptVerdict(script, 'same', walk, tally, env);
    return body.kind === 'danger' ? DANGER : OTHER;
  } finally {
    walk.expanding.delete(name);
  }
}

/**
 * Имя команды — функция снимка оболочки CLI (повторная проверка 24.10, d):
 * оболочка исполнит её тело в этой же оболочке. Тело с git, удалением,
 * погашением, обёрткой и т. п. (`riskyFunctionBody`) — человеку при любых словах
 * вызова; прочее тело судится разбором, а звено идёт правилами чата (`OTHER`),
 * как развёртка псевдонима.
 */
function functionVerdict(
  name: string,
  body: string,
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  if (riskyFunctionBody(body)) return DANGER;
  walk.expanding.add(name);
  try {
    const verdict = scriptVerdict(body, 'same', walk, tally, env);
    return verdict.kind === 'danger' ? DANGER : OTHER;
  } finally {
    walk.expanding.delete(name);
  }
}

/** Тело функции снимка, если имя звена — она (своё имя внутри тела — уже не она). */
function functionBody(head: Word, walk: Walk): string | undefined {
  const own = walk.functions;
  if (!own || head.dynamic || walk.expanding.has(head.text)) return undefined;
  return Object.hasOwn(own, head.text) ? own[head.text] : undefined;
}

function spacedVerdict(
  split: Word[],
  raw: Word[],
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  return commandVerdict([...split, ...raw.slice(1)], walk, tally, false, env);
}

/**
 * Префикс `ИМЯ=значение команда`: окружение только этой команды. Подгрузка
 * чужого кода (`LD_PRELOAD=./x.so ls`) — что исполнится, не узнать (F-15).
 */
function prefixVerdict(
  raw: Word[],
  prefix: number,
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  const rest = raw.slice(prefix);
  const scoped = new Map(env);
  let steered = false;
  for (const word of raw.slice(0, prefix)) {
    const { name, value } = assignedValue(word);
    if (steersNames(name)) return DANGER;
    // `GIT_DIR=… git push`: окружение уводит git в другой репозиторий — для
    // всего звена, и git в обёртке (`GIT_DIR=… bash -c 'git …'`) тоже.
    if (steersGit(name)) steered = true;
    const expanded = walk.expand(value);
    scoped.set(name, expanded.dynamic ? undefined : expanded.text);
  }
  if (!steered || walk.gitEnv) return commandVerdict(rest, walk, tally, false, scoped);
  walk.gitEnv = true;
  try {
    return commandVerdict(rest, walk, tally, false, scoped);
  } finally {
    walk.gitEnv = false;
  }
}

/**
 * Звено по своим словам — без перенаправлений и входа. `shell` — звено самой
 * оболочки: присваивание без команды меняет её переменные. `env` — окружение
 * префикса (`X=1 bash -c …`).
 */
function commandVerdict(
  raw: Word[],
  walk: Walk,
  tally: Tally,
  shell: boolean,
  env: Env = NO_ENV,
): SegmentVerdict {
  // Звено без команды: `> .agent/tmp/x`, `} > out` — решают перенаправления.
  if (raw.length === 0) return ROUTINE;
  const prefix = assignments(raw);
  if (prefix === raw.length) {
    if (shell) for (const word of raw) assign(word, walk);
    return ROUTINE;
  }
  if (prefix > 0) return prefixVerdict(raw, prefix, walk, tally, env);
  const head = raw[0] as Word;
  // Только свои ключи: `constructor`, `toString` из прототипа — не псевдонимы
  // (повторная проверка 24.10: такое имя команды роняло суд исключением).
  const alias =
    head.dynamic || walk.expanding.has(head.text) || !Object.hasOwn(walk.aliases ?? {}, head.text)
      ? undefined
      : walk.aliases?.[head.text];
  if (alias !== undefined) return aliasVerdict(head.text, alias, raw, walk, tally, env);
  // Функция сильнее встроенной команды и программы: `git() {…}` перехватит любой git.
  const body = functionBody(head, walk);
  if (body !== undefined) return functionVerdict(head.text, body, walk, tally, env);
  const first = walk.expand(head);
  const name = commandName(first);
  if (name === undefined) {
    const spaced = walk.spacedValue(raw[0] as Word);
    if (spaced !== undefined) return spacedVerdict(spaced, raw, walk, tally, env);
    // `$X -rf ~`: имя команды из подстановки — что исполнится, не узнать. В
    // прозе аргумента (`ssh host '…'`, текст сообщения) — не команда.
    return SCRIPT_PATH.test(first.text) || walk.prose > 0 ? OTHER : DANGER;
  }
  const named: Word = { text: name, dynamic: false };
  // `{dist,build}` и `$V` со значением в несколько слов — несколько слов: каждое судится своим путём.
  const args = raw
    .slice(1)
    .flatMap((word) => word.alternatives ?? walk.spacedValue(word) ?? [word]);
  const fed = fedVerdict([named, ...args], walk, tally, judgesFor(walk));
  if (fed) return fed;
  const builtin = builtinVerdict([named, ...args], walk);
  if (builtin) return builtin;
  // `LD_PRELOAD`, `enable` раньше в команде: имя исполнит другое (F-15).
  if (walk.namesUnknown && !SHELL_BUILTINS.has(name)) return DANGER;
  const words = [named, ...args.map((word) => walk.expand(word))];
  // Ссылки звена встают в учёт после его суда: само звено их ещё не видит.
  const links = linkTargets(linkPaths(name, words), walk);
  const unpacked = linkTargets(unpackPaths(name, words), walk);
  const verdict = namedVerdict(name, words, walk, tally, env);
  for (const link of links) walk.links.note(link);
  for (const root of unpacked) walk.links.noteUnpacked(root);
  return verdict;
}

/** Звено по имени команды, слова уже раскрыты (`commandVerdict`). */
function namedVerdict(
  name: string,
  words: Word[],
  walk: Walk,
  tally: Tally,
  env: Env,
): SegmentVerdict {
  if (name === 'git') {
    if (gitEnvRuns(walk, env)) return DANGER;
    return walk.gitEnv ? steeredGitVerdict(words, walk, env) : gitVerdict(words, walk);
  }
  const kill = isKiller(words) ? killSegment(words, walk) : undefined;
  if (kill) return kill;
  if (isRemover(name)) return removeVerdict(words, walk);
  // Скачивание в настройки дома или систему (`curl -o ~/.bashrc`) — как `> ~/.bashrc`.
  if (HTTP_CLI.has(name)) return writesVerdict(words, walk) ?? forgeVerdict(words);
  if (FORGE_CLI.has(name)) return forgeVerdict(words);
  // `sort --compress-program=./x.sh` исполнит программу (F-17).
  if (readerRuns(words)) return DANGER;
  if (readsOnly(words)) return ROUTINE;
  const written = writesVerdict(words, walk);
  if (written) return written;
  if (isProgram(name)) {
    const run = (script: string): SegmentVerdict =>
      scriptVerdict(script, 'child', walk, tally, NO_ENV);
    return name === 'sed' ? sedVerdict(words, walk, run) : awkVerdict(words, walk, run);
  }
  if (name === 'tee') return teeVerdict(words, walk);
  if (name === 'xargs') {
    const inner = xargsCommand(words);
    return inner ? commandVerdict(inner, walk, tally, false, env) : wrapped(words, true);
  }
  if (name === 'mktemp') return ROUTINE;
  if (isMake(name)) return makeVerdict(words, walk);
  // Любое слово PowerShell, называющее хранилище git, — человеку (раунд 8).
  const shell = name === 'powershell' || name === 'pwsh';
  if (shell && words.slice(1).some((word) => powershellNamesStorage(word.text, walk))) {
    return DANGER;
  }
  const unwrapped = unwrap(name, words);
  if (unwrapped) return unwrappedVerdict(unwrapped, words, walk, tally, env);
  return foreignVerdict(words, name, walk, judgesFor(walk));
}

/**
 * Пути ссылок или каталогов распаковки звена от его каталога (`links.ts`,
 * `extract.ts`); `undefined` — путь не проследить.
 */
function linkTargets(paths: (Word | undefined)[], walk: Walk): (string | undefined)[] {
  const cwd = walk.place().cwd;
  return paths.map((link) => {
    const known = link && !link.dynamic && (cwd !== undefined || isAbsolute(link.text));
    return known ? resolveFrom(cwd ?? '/', link.text) : undefined;
  });
}

/**
 * Вход, который звено исполнит, а не прочтёт: тело heredoc у `bash` — сценарий
 * нового процесса оболочки; у интерпретатора — проверкой кода; у прочих
 * (`psql`, `ssh`) — грубой проверкой, и правила чата судят его текст.
 */
function judgeInputs(inputs: string[], consumer: Word[], walk: Walk, tally: Tally): void {
  const command = consumer.slice(assignments(consumer));
  const shell = isStdinShell(command);
  const code = isInterpreter(command[0]?.text ?? '');
  for (const input of inputs) {
    const steps = shell ? parse(input) : UNPARSED;
    if (steps !== UNPARSED) {
      walk.enterChild(NO_ENV);
      judge(steps, walk, tally);
      walk.leave();
    } else if (code) {
      tally.add(codeVerdict({ codes: [input], file: false }, command, walk));
    } else if (risky(input)) {
      tally.add(DANGER);
    } else {
      tally.add(OTHER, input);
    }
  }
}

function segmentVerdict(segment: Segment, walk: Walk, tally: Tally): SegmentVerdict {
  const { words } = segment;
  let verdict = commandVerdict(words, walk, tally, true);
  if (segment.inputs.length > 0 && !readsInputAsData(words)) {
    judgeInputs(segment.inputs, words, walk, tally);
    // `bash <<'EOF'` — то, что в теле; прочий исполнитель входа — правила чата.
    if (isStdinShell(words)) verdict = ROUTINE;
    else if (verdict.kind === 'routine') verdict = OTHER;
  }
  // `> ~/.bashrc`: перезапись вне копии git не вернёт — как удаление.
  if (segment.redirects.some((redirect) => redirectOutside(redirect, walk))) return DANGER;
  if (verdict.kind !== 'routine') return verdict;
  return segment.redirects.every((redirect) => harmlessRedirect(redirect, walk)) ? verdict : OTHER;
}

/** Обёртки, что исполняют следующее слово как есть: `sudo sh`, `env bash`, `timeout 60 node`. */
const PASS_THROUGH = new Set([
  'sudo',
  'doas',
  'env',
  'nice',
  'nohup',
  'timeout',
  'command',
  'exec',
]);
/** Ключи `sudo`/`doas` и `nice` со значением отдельным словом. */
const VALUED_FLAG = /^-[ugCDhpRrTUn]$/;

/**
 * Звено исполнит то, что придёт по трубе: оболочка без сценария, интерпретатор
 * без программы — и они же за `sudo`/`env`/`timeout`; `iex` PowerShell (R-C01).
 */
function runsInputThrough(words: Word[]): boolean {
  let rest = words;
  for (;;) {
    const name = (rest[0]?.text.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
    if (name === 'iex' || name === 'invoke-expression') return rest.length === 1;
    if (!PASS_THROUGH.has(name)) return runsInput(rest);
    rest = rest.slice(1);
    while (rest.length > 0) {
      const text = (rest[0] as Word).text;
      const option = text.startsWith('-') || /^[A-Za-z_]\w*=/.test(text);
      if (!option && !(name === 'timeout' && /^\d/.test(text))) break;
      rest = rest.slice(VALUED_FLAG.test(text) && name !== 'env' ? 2 : 1);
    }
  }
}

function judge(steps: Step[], walk: Walk, tally: Tally): void {
  // Тела heredoc и печать звеньев раньше по трубе: `cat <<'EOF' | bash` исполнит тело.
  let upstream: string[] = [];
  let previousJudged = true;
  for (const step of steps) {
    if (tally.danger) return;
    if (step === ENTER) walk.enter();
    else if (step === LEAVE) walk.leave();
    else if (step === BLIND) walk.blind();
    else {
      if (!step.piped) upstream = [];
      walk.atChain(step.chain);
      const fed = upstream;
      // `cat list.txt | sh` и `curl … | bash` исполнят непрочитанное. Строка
      // правил чата «сеть и исполнение» звено за звеном не срабатывает — трубы
      // в тексте звена нет (R-C01), поэтому скачанное решается здесь же.
      const blindFeed = step.piped && !previousJudged;
      previousJudged = knownOutput(step.words, step.inputs);
      upstream = [...upstream, ...step.inputs, ...printed(step.words)];
      if (blindFeed && runsInputThrough(step.words)) {
        tally.add(DANGER);
        return;
      }
      if (fed.length > 0 && !readsInputAsData(step.words)) {
        judgeInputs(fed, step.words, walk, tally);
      }
      const text = step.words.map((word) => word.text).join(' ');
      const texts = [...step.words, ...step.redirects.map((redirect) => redirect.target)];
      // `for p in a b; do $p …`: звено судится по разу на каждое значение.
      walk.eachValue(
        texts.map((word) => word.text),
        () => {
          if (!tally.danger) tally.add(segmentVerdict(step, walk, tally), text);
        },
      );
    }
  }
}

/** Обработчики `trap` в обработчиках — не глубже: дальше человеку. */
const MAX_DEFERRED_ROUNDS = 8;

/**
 * Обработчики `trap` судятся в конце, с состоянием конца команды (F-02).
 * Поставленный в подоболочке — вслепую: её состояние к выходу не проследить.
 */
function judgeDeferred(walk: Walk, tally: Tally): void {
  for (let round = 0; round < MAX_DEFERRED_ROUNDS; round += 1) {
    const deferred = walk.takeDeferred();
    if (deferred.length === 0) return;
    for (const { script, blind } of deferred) {
      if (tally.danger) return;
      const steps = parse(script);
      if (steps === UNPARSED) {
        tally.add(risky(script) ? DANGER : OTHER, script);
        continue;
      }
      if (blind) {
        walk.enter();
        walk.blind();
      }
      judge(steps, walk, tally);
      if (blind) walk.leave();
    }
  }
  if (walk.takeDeferred().length > 0) tally.add(DANGER);
}

/** Команда инструмента PowerShell называет хранилище git (раунд 8) — как `pwsh -c`. */
export function powershellToolStorage(command: string, scope: GroupCommandScope): boolean {
  return powershellNamesStorage(command, new Walk(scope));
}

export function groupCommandVerdict(
  command: string,
  scope: GroupCommandScope,
): GroupCommandVerdict {
  const steps = parse(command);
  if (steps === UNPARSED) {
    // Погашение в строке, которую не разобрать, — цель не назвать (N3).
    if (risky(command) || killsProcess(command)) return { kind: 'danger' };
    return {
      kind: 'other',
      texts: [command],
      rules: [],
      writes: false,
      lease: false,
      deletes: false,
    };
  }
  const tally = new Tally();
  const walk = new Walk(scope);
  walk.stable = stableNames(command);
  judge(steps, walk, tally);
  if (!tally.danger) judgeDeferred(walk, tally);
  return tally.result();
}

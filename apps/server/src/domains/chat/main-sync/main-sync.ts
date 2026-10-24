/**
 * Группа не догоняет целевую ветку (rebase/merge/pull `main`), пока с ней нет
 * конфликта (решение владельца 19.10): отставший MR обновляет человек сам.
 *
 * Почему: целевую ветку заливают постоянно. Группа догоняет её rebase'ом,
 * гонит гейт заново (13–20 мин), а за это время вливается следующий MR — и
 * круг идёт снова. Замер 19.10: группы KB и Конструктора по нескольку раз
 * переносили ветку и прогоняли гейт целиком только потому, что main сдвинулся.
 * Брокер сверяет конфликт сам (`conflictsWith`): есть — догон пропускается и
 * конфликт чинится сразу; нет — отказ с `MAIN_SYNC_DENIED`, без карточки.
 */

import {
  conflictsBetween,
  isHiddenSync,
  remoteConflicts,
  runGit,
  serverConflicts,
  type GitRunner,
} from './conflicts.ts';

/**
 * Оболочки, чей сценарий текстом (`bash -c '…'`) разбор догона читает
 * (`wrappedScripts`). Одна таблица для разбора и для правил `ask` (повторная
 * проверка 24.10, b): правила знали `bash`/`sh`/`zsh`, разбор — ещё `dash`,
 * `ksh`, `mksh`, `.exe` и любой регистр, и такой догон в авторежиме до брокера
 * не доходил.
 */
export const WRAPPER_SHELLS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh'];
const WRAPPER_SHELL = new RegExp(`(^|[\\\\/])(${WRAPPER_SHELLS.join('|')})(\\.exe)?$`, 'i');

/**
 * Правила `ask` под обёртки из `WRAPPER_SHELLS` и `eval`: имя как есть, после
 * другой команды (`env bash -c`, `timeout 60 sh -c`), полным путём и `.exe`, в
 * трёх написаниях регистра.
 */
const WRAPPER_ASK: readonly string[] = [
  ...WRAPPER_SHELLS.flatMap((shell) =>
    [shell, shell[0]!.toUpperCase() + shell.slice(1), shell.toUpperCase()].flatMap((name) => [
      `Bash(${name} *)`,
      `Bash(* ${name} *)`,
      `Bash(*/${name} *)`,
      `Bash(*${name}.exe *)`,
    ]),
  ),
  'Bash(eval *)',
  'Bash(* eval *)',
];

/**
 * Правила `ask` для CLI: в авторежиме без них вызов до брокера не доходит
 * (классификатор CLI пропускает rebase сам). Шире, чем нужно, намеренно —
 * `rebase --continue` тоже придёт к брокеру, но там его пропустит
 * `syncsWithTarget`: правило только ведёт вызов к брокеру, решает он.
 */
export const MAIN_SYNC_ASK: readonly string[] = [
  ...WRAPPER_ASK,
  'Bash(git rebase *)',
  'Bash(git -C * rebase *)',
  'Bash(git pull *)',
  'Bash(git -C * pull *)',
  'Bash(git merge *)',
  'Bash(git -C * merge *)',
  // Перестановка своей ветки на старт из целевой — тот же догон (D2, 23.10).
  'Bash(git checkout -B *)',
  'Bash(git -C * checkout -B *)',
  'Bash(git switch -C *)',
  'Bash(git -C * switch -C *)',
  // Те же перестановки другими подкомандами (F-32): `reset --hard origin/main`,
  // `branch -f своя origin/main`, `switch -c t origin/main`, `cherry-pick ..origin/main`.
  'Bash(git reset *)',
  'Bash(git -C * reset *)',
  'Bash(git branch *)',
  'Bash(git -C * branch *)',
  'Bash(git switch *)',
  'Bash(git -C * switch *)',
  'Bash(git checkout *)',
  'Bash(git -C * checkout *)',
  'Bash(git cherry-pick *)',
  'Bash(git -C * cherry-pick *)',
  'Bash(git update-ref *)',
  'Bash(git -C * update-ref *)',
  'Bash(git fetch *)',
  'Bash(git -C * fetch *)',
  // Догон содержимым и заплаткой (RF-BGCD-12b): `restore --source=origin/main .`,
  // `read-tree -m -u origin/main`, `git diff origin/main | git apply`.
  'Bash(git restore *)',
  'Bash(git -C * restore *)',
  'Bash(git read-tree *)',
  'Bash(git -C * read-tree *)',
  'Bash(git apply)',
  'Bash(git apply *)',
  'Bash(git -C * apply *)',
  'Bash(git am)',
  'Bash(git am *)',
  'Bash(git -C * am *)',
];

/** Ветки, которые считаются целевыми, когда названы без `origin/`. */
const TARGET_NAMES = /^(main|master|develop|dev|trunk|release(\/.*)?)$/i;

/** Шаги уже идущего переноса — не новая синхронизация. */
const IN_PROGRESS = new Set(['--continue', '--abort', '--skip', '--quit', '--edit-todo']);

/** Звенья составной команды: `a && b | c; d`. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Слова звена без кавычек вокруг. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
}

/** Подкоманда git и её аргументы; глобальные опции (`-C dir`, `-c k=v`, `--no-pager`) пропущены. */
function gitCall(segment: string): { sub: string; args: string[] } | undefined {
  const list = words(segment);
  const at = list.findIndex((w) => /(^|[\\/])git(\.exe)?$/i.test(w));
  if (at < 0) return undefined;
  let i = at + 1;
  while (i < list.length) {
    const w = list[i] ?? '';
    if (w === '-C' || w === '-c') i += 2;
    else if (w.startsWith('--') && !w.includes('=') && ['--git-dir', '--work-tree'].includes(w))
      i += 2;
    else if (w.startsWith('-')) i += 1;
    else break;
  }
  const sub = list[i];
  return sub ? { sub, args: list.slice(i + 1) } : undefined;
}

/** Аргумент называет удалённую или целевую ветку. */
function isTargetRef(arg: string): boolean {
  if (arg.startsWith('-')) return false;
  if (arg === 'FETCH_HEAD') return true;
  if (/^(origin|upstream)\/\S+/.test(arg)) return true;
  if (/^refs\/remotes\//.test(arg)) return true;
  return TARGET_NAMES.test(arg);
}

/**
 * Ключи, берущие значение отдельным словом, по подкомандам (F-32): `-X theirs`,
 * `-m main`, `--exec main`. Значение — не ссылка: `merge -m main feat` не догон,
 * а `rebase -X theirs <хэш>` сверяется по хэшу, а не по «theirs». Список по
 * подкоманде, а не общий: `-x` у cherry-pick и `-S` у merge значения не берут —
 * общий список проглотил бы следом идущую ссылку и пропустил догон.
 */
const STRATEGY = ['-X', '-s', '--strategy', '--strategy-option'];
const VALUED: Record<string, ReadonlySet<string>> = {
  rebase: new Set([...STRATEGY, '-x', '--exec', '--onto']),
  merge: new Set([...STRATEGY, '-m', '-F', '--file', '--cleanup', '--into-name']),
  'cherry-pick': new Set([...STRATEGY, '-m', '--mainline', '--cleanup']),
  branch: new Set(['-u', '--set-upstream-to']),
  checkout: new Set(['-b', '-B', '--orphan']),
  switch: new Set(['-c', '-C', '--create', '--force-create', '--orphan']),
};
const NONE: ReadonlySet<string> = new Set();

/** Позиционные слова звена подкоманды `sub`: ключи и их значения пропущены. */
function positionals(sub: string, args: string[]): string[] {
  const valued = VALUED[sub] ?? NONE;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') break;
    if (valued.has(arg)) i += 1;
    else if (!arg.startsWith('-')) rest.push(arg);
  }
  return rest;
}

/**
 * Ссылка, на которую звено ставит ветку или копию (`reset --hard <ref>`,
 * `branch -f <ветка> <ref>`, `switch -c <ветка> <ref>`, `checkout -B <ветка> <ref>`),
 * или коммиты, которые оно тянет (`cherry-pick <a>..<ref>`). `undefined` — не такое звено.
 */
function placesAt(sub: string, args: string[]): string | undefined {
  const pos = positionals(sub, args);
  // С `--` это пути: `reset <ref> -- файл` трогает индекс, `checkout <ref> -- файл` — файлы.
  const paths = args.includes('--');
  if (paths && sub !== 'branch') return undefined;
  if (sub === 'reset') return pos[0];
  if (sub === 'checkout' || sub === 'switch') {
    // Создание ветки от старта или отсоединённая копия на ссылке — перестановка;
    // переход на локальную `main` — не догон своей ветки (её ведут правила пуша).
    const creates = args.some((a) => VALUED[sub]?.has(a) && a !== '--orphan');
    const remote = /^(origin|upstream)\/|^refs\/remotes\/|^FETCH_HEAD$/.test(pos[0] ?? '');
    return creates || remote || args.includes('--detach') ? pos[0] : undefined;
  }
  if (sub === 'branch') {
    // Создание или перестановка ветки от старта: `branch [-f] <ветка> <старт>`.
    const other = args.some((a) =>
      /^(-[dDmMcClrav]+|--(delete|move|copy|list|all|remotes|contains|no-contains|merged|no-merged|points-at|show-current|edit-description|unset-upstream|format|sort)(=.*)?)$/.test(
        a,
      ),
    );
    return other ? undefined : pos[1];
  }
  if (sub === 'update-ref') return args.includes('-d') ? undefined : pos[1];
  if (sub === 'cherry-pick') {
    const tips = pos.map((a) => (a.includes('..') ? a.slice(a.lastIndexOf('..') + 2) : a));
    return tips.find(isTargetRef) ?? tips.at(-1);
  }
  return undefined;
}

/** `fetch origin main:своя` / `+main:своя` — ветка ставится на целевую мимо rebase. */
function fetchPlaces(args: string[]): string | undefined {
  for (const spec of positionals('fetch', args).slice(1)) {
    const [src, dst] = spec.replace(/^\+/, '').split(':');
    // `main:main` лишь обновляет локальную целевую, свою ветку не трогает.
    if (!src || !dst || TARGET_NAMES.test(dst.replace(/^refs\/heads\//, ''))) continue;
    const name = src.replace(/^refs\/heads\//, '');
    if (TARGET_NAMES.test(name)) return `origin/${name}`;
  }
  return undefined;
}

/** Пути «всё дерево»: `.`, `:/`, `*` — не один файл, а содержимое ветки целиком. */
const WHOLE_TREE = /^(?:\.\/?|:\/\.?|\*|:\(top\)\.?)$/;

/** Ссылка-источник `restore`: `--source=X`, `--source X`, `-s X`, `-sX`. */
function restoreSource(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') break;
    if (arg === '--source' || arg === '-s') return args[i + 1];
    if (arg.startsWith('--source=')) return arg.slice('--source='.length);
    if (/^-s\S+/.test(arg)) return arg.slice(2);
  }
  return undefined;
}

/**
 * Догон содержимым, без переноса истории (RF-BGCD-12b): дерево целевой ветки
 * целиком кладётся поверх своего — `checkout origin/main -- .`, `restore
 * --source=origin/main .`, `read-tree -m -u origin/main`. Итог тот же, что у
 * догона, только без merge-коммита. Один файл из целевой (`checkout origin/main --
 * a.ts`) — не догон: так берут образец. Возвращает целевую ссылку.
 */
function contentSync(sub: string, args: string[]): string | undefined {
  const dash = args.indexOf('--');
  const paths = dash >= 0 ? args.slice(dash + 1) : [];
  if (sub === 'checkout') {
    const ref = positionals('checkout', args)[0];
    return ref && isTargetRef(ref) && paths.some((p) => WHOLE_TREE.test(p)) ? ref : undefined;
  }
  if (sub === 'restore') {
    const ref = restoreSource(args);
    if (!ref || !isTargetRef(ref)) return undefined;
    const own =
      dash >= 0
        ? paths
        : args.filter(
            (a, i) => !a.startsWith('-') && args[i - 1] !== '-s' && args[i - 1] !== '--source',
          );
    return own.some((p) => WHOLE_TREE.test(p)) ? ref : undefined;
  }
  if (sub === 'read-tree') {
    return positionals('read-tree', args).find(isTargetRef);
  }
  return undefined;
}

/** Стороны диапазона: `a..b`, `a...b` — обе ссылки. */
function rangeSides(arg: string): string[] {
  return arg.split(/\.{2,3}/).filter(Boolean);
}

/**
 * Догон заплаткой (RF-BGCD-12b): разница с целевой веткой, наложенная в той же
 * команде, — `git diff origin/main | git apply`, `git format-patch ..origin/main
 * | git am`, через файл (`> p.diff; git apply p.diff`). Возвращает целевую ссылку.
 */
function patchSync(command: string): string | undefined {
  const calls = segments(command)
    .map(gitCall)
    .filter((call): call is { sub: string; args: string[] } => call !== undefined);
  if (!calls.some((call) => call.sub === 'apply' || call.sub === 'am')) return undefined;
  for (const { sub, args } of calls) {
    if (sub !== 'diff' && sub !== 'format-patch') continue;
    const target = positionals(sub, args).flatMap(rangeSides).find(isTargetRef);
    if (target) return target;
  }
  return undefined;
}

/** Подкоманды, печатающие содержимое ветки: заплатку, файл, дерево. */
const EXPORTS = new Set([
  'diff',
  'diff-tree',
  'format-patch',
  'show',
  'log',
  'archive',
  'cat-file',
]);
/** Ключи, с которыми печатается содержимое, а не сводка. */
const CONTENT_FLAG = /^(-p|-u|--patch|--patch-with-stat|--patch-with-raw|-U\d*|--unified(=\d+)?)$/;
/** Ключи сводки без содержимого: имена, счётчики, код выхода. */
const SUMMARY_FLAG =
  /^(--stat(=\S*)?|--numstat|--shortstat|--dirstat(=\S*)?|--compact-summary|--name-only|--name-status|--summary|--quiet|--exit-code|--raw|--check|-s|--no-patch)$/;
/** Ключи выгрузки со значением отдельным словом: значение — не ссылка. */
const EXPORT_VALUED: Record<string, ReadonlySet<string>> = {
  'format-patch': new Set([
    '-o',
    '--output-directory',
    '--subject-prefix',
    '--suffix',
    '--start-number',
    '-v',
    '--reroll-count',
    '--in-reply-to',
    '--to',
    '--cc',
  ]),
  archive: new Set(['-o', '--output', '--format', '--prefix', '--remote', '--exec']),
  log: new Set(['-n', '--max-count', '--author', '--committer', '--grep', '--since', '--until']),
};

/** Вызов печатает содержимое, а не только сводку (`--stat`, `--name-only`). */
function emitsContent(sub: string, args: string[]): boolean {
  if (sub === 'archive' || sub === 'format-patch') return true;
  if (sub === 'cat-file') return !args.some((a) => /^-[tse]$/.test(a));
  if (args.some((a) => CONTENT_FLAG.test(a))) return true;
  if (sub === 'log' || sub === 'diff-tree') return false;
  return !args.some((a) => SUMMARY_FLAG.test(a));
}

/**
 * Ссылки, содержимое которых вызов печатает. `diff a...b` — от общей базы до
 * `b` (своя ветка против `origin/main...HEAD` — свои правки, не целевой);
 * `log`/`format-patch a..b` — коммиты `b`, которых нет в `a`, `a...b` — обеих;
 * `format-patch <ref>` без `-<n>`/`--root` — «с `<ref>`», то есть свои коммиты.
 */
function exportedRefs(sub: string, args: string[]): string[] {
  const valued = EXPORT_VALUED[sub] ?? NONE;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') break;
    if (valued.has(arg)) i += 1;
    else if (!arg.startsWith('-')) pos.push(arg);
  }
  const refs: string[] = [];
  for (const word of pos) {
    const three = word.split('...');
    const two = word.split('..');
    if (three.length === 2) {
      const [left, right] = three as [string, string];
      if (sub === 'diff') refs.push(right || 'HEAD');
      else refs.push(left, right);
    } else if (two.length === 2) {
      const [left, right] = two as [string, string];
      refs.push(...(sub === 'diff' ? [left, right] : [right]));
    } else if (sub === 'format-patch' && !args.some((a) => /^(-\d+|--root)$/.test(a))) continue;
    else refs.push(word.replace(/:.*$/, ''));
  }
  return refs.filter(Boolean);
}

/** Целевая ветка, содержимое которой печатает вызов git; `undefined` — не такой. */
function exportCall(text: string): { refs: string[]; writes: boolean } | undefined {
  const call = gitCall(text);
  if (!call) return undefined;
  const { sub, args } = call;
  if (sub === 'worktree') {
    // `worktree add <путь> origin/main` — дерево целевой рядом, откуда его копируют.
    const [verb, ...rest] = positionals('worktree', args);
    return verb === 'add' ? { refs: rest.slice(1), writes: true } : undefined;
  }
  if (!EXPORTS.has(sub) || !emitsContent(sub, args)) return undefined;
  const writes =
    (sub === 'format-patch' && !args.includes('--stdout')) ||
    args.some((a) => /^(-o|--output(-directory)?)(=|$)|^-o\S/.test(a));
  return { refs: exportedRefs(sub, args), writes };
}

/** Какую ссылку выгрузки ищем: целевую по имени или хэш, догон ли он — решит git. */
type RefPick = (refs: string[]) => string | undefined;
const targetOf: RefPick = (refs) => refs.find(isTargetRef);
/** `git diff HEAD 3f2a1b9 > p` — целевая по хэшу (тот же обход, что `git rebase <sha>`, D2). */
const hashOf: RefPick = (refs) => refs.find((ref) => /^[0-9a-f]{7,40}$/i.test(ref));

/**
 * `$(git rev-parse origin/main)` и `M=origin/main; git diff $M > p` — та же
 * ссылка, написанная иначе (повторная проверка 24.10): текстом подставляется
 * её имя, и выгрузка судится по нему.
 */
const REV_PARSE =
  /\$\(\s*git\s+rev-parse\s+(?:-{1,2}[\w-]+\s+)*([^\s()$`'"^]+)(?:\^\{\w*\})?\s*\)/g;

function resolveRefs(list: string[]): string[] {
  const known = new Map<string, string>();
  return list.map((statement) => {
    let text = statement.replace(REV_PARSE, (_all, ref: string) => ref);
    for (const [name, value] of known) {
      text = text.replace(new RegExp(`"?\\$(?:${name}\\b|\\{${name}\\})"?`, 'g'), value);
    }
    const assigned = /^\s*(?:export\s+|local\s+)?(\w+)=(["']?)([^\s'"$`;|&<>()]+)\2\s*$/.exec(text);
    const reassigned = /^\s*(?:export\s+|local\s+|readonly\s+)?(\w+)=/.exec(text);
    if (assigned) known.set(assigned[1] as string, assigned[3] as string);
    // `T=$(cat ref)` после `T=origin/main`: прежнее имя уже не то — не подставлять.
    else if (reassigned) known.delete(reassigned[1] as string);
    return text;
  });
}

/**
 * Текст команды для сверки догона: `$(git rev-parse origin/main)` и переменная
 * с буквальной ссылкой (`T=origin/main; git rebase $T`) заменены самой ссылкой
 * (повторная проверка 24.10, c). Без этого цель читалась как `origin/main)` и
 * сверка конфликта отказывала «не удалось сверить», а `$T` уходил человеку.
 * Звенья соединяются переводом строки — делит их и `segments`, а `isSoleSync`
 * по-прежнему видит одно звено только там, где оно одно.
 */
export function resolvedSyncText(command: string): string {
  const list = statements(command);
  const resolved = resolveRefs(list);
  return resolved.every((text, i) => text === list[i]) ? command : resolved.join('\n');
}

/**
 * Вывод в файл: `>`, `>>`, `1>`, `&>`, `>|`, `>& p` — не `2>`, не `>&2`, не
 * `>&-`, не `/dev/null`. `>& p` с именем — файл, а не копия дескриптора
 * (повторная проверка 24.10: `git diff origin/main >& p` проходил сам).
 */
const FILE_OUT =
  /(?:^|[^\d&>])[1&]?>>?\|?(?:&(?!\s*(?:\d+|-)(?:\s|$))|(?!&))\s*(?!\/dev\/(?:null|stdout|stderr)\b)(?=\S)/;

/** Команды, что только показывают вход: их выход не ложится в файл сам. */
const VIEWERS = new Set([
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'wc',
  'less',
  'more',
  'cat',
  'sort',
  'uniq',
  'cut',
  'sed',
  'awk',
  'column',
  'nl',
  'tr',
  'jq',
  'echo',
  'printf',
  'diff',
  'cmp',
  'comm',
  'test',
  '[',
  'true',
  'false',
  'xxd',
  'od',
  'md5sum',
  'sha1sum',
  'sha256sum',
]);
/** Подкоманды git, что только читают. */
const GIT_READS = new Set([
  'diff',
  'show',
  'log',
  'status',
  'rev-parse',
  'cat-file',
  'ls-files',
  'ls-tree',
  'merge-base',
  'grep',
  'blame',
  'shortlog',
  'rev-list',
  'describe',
  'name-rev',
  'for-each-ref',
  'show-ref',
  // В вывод — только с `--stdout` / без `-o`; запись в файл ловит `exportCall().writes`.
  'format-patch',
  'archive',
]);

/** Звено только показывает: просмотрщик без `sed -i`, или читающий git. */
function isViewer(stage: string): boolean {
  const word = stage
    .trim()
    .replace(/^(?:[({!\s]|(?:do|then|else|time)\s)+/, '')
    .replace(/^(?:\w+=\S*\s+)+/, '')
    .split(/\s+/)[0];
  const name = (word ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  if (name === 'git' || /^git$/i.test(name)) {
    const call = gitCall(stage);
    const found = exportCall(stage);
    const writesTarget = found !== undefined && found.writes && targetOf(found.refs) !== undefined;
    return call !== undefined && GIT_READS.has(call.sub) && !writesTarget;
  }
  if (name === 'sed' && /\s-i|\s--in-place/.test(stage)) return false;
  return VIEWERS.has(name);
}

/** Звенья команды без деления по `|`: `a && b; c`. */
function statements(command: string): string[] {
  return splitOutside(command, /^(&&|\|\||;|\n)/);
}

/** Звенья цепочки `a | b |& c` вне кавычек: `grep "a\|b"` — одно звено. */
function pipes(statement: string): string[] {
  return splitOutside(statement, /^(\|&|\|(?!\|))/);
}

/**
 * Делит по разделителю `sep` вне кавычек и вне `$(…)`/`<(…)`: `|` в шаблоне
 * `grep "a\|b"` и `;` внутри подстановки — не граница звена.
 */
function splitOutside(text: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let quote = '';
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '\\' && quote !== "'") i += 1;
    else if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const found = sep.exec(text.slice(i))?.[0];
      if (found) {
        parts.push(text.slice(from, i));
        i += found.length - 1;
        from = i + 1;
      }
    }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Звено вывод сохраняет: в файл или в команду, что не только показывает. */
function keeps(stages: string[]): boolean {
  return stages.some(
    (stage) => FILE_OUT.test(stage.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")) || !isViewer(stage),
  );
}

/**
 * Догон через файл или дерево (RF-BGCD-12b, раунд 9, 24.10): содержимое целевой
 * ветки ложится в файл или каталог одной командой, а накладывается другой —
 * `git diff origin/main > p` и потом `git apply p`/`patch -p1 < p`, `git
 * archive origin/main | tar -x`, `git show origin/main:a > a`, `worktree add
 * … origin/main` и `cp` оттуда. Каждый вызов Bash разбирается отдельно, второй
 * шаг (`git apply p`) целевой уже не называет — поэтому догоном считается сама
 * запись. Просмотр (`| head`, `--stat`, `--name-only`, `origin/main...HEAD`)
 * — не запись. Возвращает целевую ссылку.
 */
function exportSync(command: string, pick: RefPick = targetOf): string | undefined {
  const list = resolveRefs(statements(command));
  const shaped = keptByShape(list);
  for (const [index, whole] of list.entries()) {
    let statement = whole;
    // Подстановки изнутри наружу: `echo "$(git diff …)" > p`, `X=$(git show origin/main:a)`,
    // `diff <(git show origin/main:a) a`. Разобранная становится словом `SUB`; подоболочка
    // `( … ) > p` — словом `true`: её вывод — вывод самой строки.
    for (let match = SUBSTITUTION.exec(statement); match; match = SUBSTITUTION.exec(statement)) {
      const inner = statements(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
      const outer = statement.replace(match[0], match[4] === undefined ? ' SUB ' : ' true ');
      const name = /^\s*(?:export\s+|local\s+)?(\w+)=["']?\s*SUB\s*["']?$/.exec(outer)?.[1];
      // Значение в переменной уходит в звенья дальше — сохраняет то, что её читает.
      const later = (): boolean =>
        list
          .slice(index + 1)
          .some((s) => (s.includes(`$${name}`) || s.includes(`\${${name}}`)) && keeps(pipes(s)));
      const tail = (): boolean => shaped[index] === true || (name ? later() : keeps(pipes(outer)));
      for (const part of inner) {
        const target = pipeExport(pipes(part), tail, pick);
        if (target) return target;
      }
      statement = outer;
    }
    const target = pipeExport(pipes(statement), () => shaped[index] === true, pick);
    if (target) return target;
  }
  return undefined;
}

const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)|(?<![$<>\w])\(([^()]*)\)/;

/** Начало составной команды, чей вывод перенаправляет её последнее звено (`} > p`, `done > p`). */
const OPENER = /^(?:\{|if|while|until|for|case|select)(?:\s|$)/;
const CLOSER = /^(?:\}|fi|done|esac)(?=\s|[|>&]|$)/;
/** `f() {` / `function f {`: куда уйдёт вывод тела, решает вызов, — не проследить. */
const FUNCTION = /^(?:function\s+[\w.:-]+|[\w.:-]+\s*\(\s*\))/;
/** `exec > p` без команды: вывод всех звеньев дальше — в файл. */
const EXEC_ONLY = /^exec(?:\s+(?:\d*|&)>>?\|?&?\s*\S+)+\s*$/;

/**
 * Звенья, чей вывод сохраняет форма команды вокруг них, а не их собственная
 * цепочка (повторная проверка 24.10): `{ git diff origin/main; } > p`, `for …;
 * do git show origin/main:$f; done > out`, `exec > p; git diff origin/main`,
 * тело функции. Раньше каждое звено судилось само, и `{ …; } > p` проходил.
 */
function keptByShape(list: string[]): boolean[] {
  const kept = list.map(() => false);
  const open: { at: number; fn: boolean }[] = [];
  for (const [index, statement] of list.entries()) {
    if (FUNCTION.test(statement)) open.push({ at: index, fn: true });
    else if (OPENER.test(statement)) open.push({ at: index, fn: false });
    if (EXEC_ONLY.test(statement) && FILE_OUT.test(statement)) {
      for (let k = index + 1; k < list.length; k += 1) kept[k] = true;
    }
    if (!CLOSER.test(statement)) continue;
    const top = open.pop();
    if (top && (top.fn || keeps(pipes(statement.replace(CLOSER, ''))))) {
      for (let k = top.at; k <= index; k += 1) kept[k] = true;
    }
  }
  return kept;
}

/** Цепочка `a | b | c`: целевая, чей вывод цепочка (или `tail` снаружи) сохраняет. */
function pipeExport(stages: string[], tail: () => boolean, pick: RefPick): string | undefined {
  for (let k = 0; k < stages.length; k += 1) {
    const found = exportCall(stages[k] as string);
    const ref = found && pick(found.refs);
    if (found && ref && (found.writes || keeps(stages.slice(k)) || tail())) return ref;
  }
  return undefined;
}

function segmentSyncs(segment: string): boolean {
  const call = gitCall(segment);
  if (!call) return false;
  const { sub, args } = call;
  if (args.some((a) => IN_PROGRESS.has(a))) return false;
  if (contentSync(sub, args) !== undefined) return true;
  if (sub === 'rebase' || sub === 'merge') {
    // `--onto <база>` — перенос на названную базу; иначе — первый позиционный.
    const onto = args.indexOf('--onto');
    if (onto >= 0 && isTargetRef(args[onto + 1] ?? '')) return true;
    const ontoEq = args.find((a) => a.startsWith('--onto='));
    if (ontoEq && isTargetRef(ontoEq.slice('--onto='.length))) return true;
    return positionals(sub, args).some(isTargetRef);
  }
  // Перестановка ветки или копии на целевую — тот же догон (F-32).
  const placed = placesAt(sub, args);
  if (placed !== undefined) return isTargetRef(placed);
  if (sub === 'fetch') return fetchPlaces(args) !== undefined;
  if (sub === 'pull') {
    // `git pull` своей ветки без аргументов — не догон main; `git pull origin main` — он.
    const positional = args.filter((a) => !a.startsWith('-'));
    return (
      positional.slice(1).some((a) => TARGET_NAMES.test(a.replace(/^.*:/, ''))) ||
      positional.some((a) => /^(origin|upstream)\/\S+/.test(a))
    );
  }
  return false;
}

/**
 * Сценарий обёртки оболочки текстом: `bash -c '…'`, `sh -lc "…"`, `eval '…'`
 * (повторная проверка 24.10). Догон внутри обёртки разбор не видел: `bash -c
 * 'git rebase origin/main'` и `sh -c 'git diff origin/main > p'` шли мимо
 * сверки конфликта.
 */
function wrappedScripts(command: string): string[] {
  const scripts: string[] = [];
  for (const statement of statements(command)) {
    for (const stage of pipes(statement)) {
      const list = words(stage);
      const shell = list.findIndex((w) => WRAPPER_SHELL.test(w));
      const flag = list.findIndex((w, i) => shell >= 0 && i > shell && /^-[a-z]*c[a-z]*$/i.test(w));
      const script = flag >= 0 ? list[flag + 1] : undefined;
      if (script) scripts.push(script);
      const evaluated = list.indexOf('eval');
      if (evaluated >= 0) scripts.push(list.slice(evaluated + 1).join(' '));
    }
  }
  return scripts;
}

/** Команда переносит ветку на свежую целевую ветку (или вливает её). */
export function syncsWithTarget(command: string): boolean {
  return (
    segments(command).some(segmentSyncs) ||
    patchSync(command) !== undefined ||
    exportSync(command) !== undefined ||
    wrappedScripts(command).some(syncsWithTarget)
  );
}

/**
 * Вся команда — один догон, в своей копии (без `-C` в чужую) и без других
 * звеньев. Только такой при конфликте пропускается без карточки: конфликт
 * группа чинит сразу (правило владельца 19.10), а `git merge origin/main &&
 * git push origin main` в хвосте понёс бы мимо разбора и пуш в main.
 */
export function isSoleSync(command: string): boolean {
  const parts = segments(command);
  const call = parts.length === 1 ? gitCall(parts[0]!) : undefined;
  // Только перенос и вливание: `reset --hard origin/main` при конфликте решают
  // строки группы (со снимком незакоммиченного), а не этот короткий путь.
  if (!call || !/^(rebase|merge|pull)$/.test(call.sub)) return false;
  return segmentSyncs(parts[0]!) && !/\s-C\s/.test(parts[0]!);
}

/** Целевая ветка команды догона — то, с чем сверять конфликты. */
export function syncTarget(command: string): string | undefined {
  for (const segment of segments(command)) {
    if (!segmentSyncs(segment)) continue;
    const { sub, args } = gitCall(segment) ?? { sub: '', args: [] };
    const positional = args.filter((a) => !a.startsWith('-'));
    if (sub === 'pull') {
      const named = positional.find((a) => /^(origin|upstream)\/\S+/.test(a));
      if (named) return named;
      const [remote, branch] = positional;
      return remote && branch ? `${remote}/${branch.replace(/^.*:/, '')}` : undefined;
    }
    const content = contentSync(sub, args);
    if (content !== undefined) return content;
    const placed = placesAt(sub, args) ?? (sub === 'fetch' ? fetchPlaces(args) : undefined);
    if (placed !== undefined) return placed;
    const onto = args.indexOf('--onto');
    if (onto >= 0 && isTargetRef(args[onto + 1] ?? '')) return args[onto + 1];
    const ontoEq = args.find((a) => a.startsWith('--onto='));
    if (ontoEq) return ontoEq.slice('--onto='.length);
    return positionals(sub, args).find(isTargetRef);
  }
  return (
    patchSync(command) ??
    exportSync(command) ??
    wrappedScripts(command)
      .map(syncTarget)
      .find((target) => target !== undefined)
  );
}

/**
 * Ссылка, на которую команда переносит или переставляет ветку, когда она не
 * названа целевой (`git rebase <sha>`, `git merge <sha>`, `git checkout -B
 * своя <старт>`, `git switch -C своя <старт>`). Догон ли это, решает git
 * (`isHiddenSync`): так группы обходили отказ 23.10 (D2).
 */
export function syncCandidate(command: string): string | undefined {
  for (const segment of segments(command)) {
    if (segmentSyncs(segment)) continue;
    const call = gitCall(segment);
    if (!call) continue;
    const { sub, args } = call;
    if (args.some((a) => IN_PROGRESS.has(a))) continue;
    if (sub === 'rebase' || sub === 'merge') {
      const onto = args.indexOf('--onto');
      if (onto >= 0 && args[onto + 1]) return args[onto + 1];
      const positional = positionals(sub, args);
      if (positional[0]) return positional[0];
      // `git merge -` — прошлая ветка копии, которой могла быть и целевая.
      if (args.includes('-')) return '@{-1}';
      continue;
    }
    // `git pull origin "$B"`: ветку из переменной не назвать — догон ли это, не узнать.
    if (sub === 'pull') {
      const dynamic = args.find((a) => !a.startsWith('-') && isUnnamedRef(a));
      if (dynamic) return dynamic;
      continue;
    }
    // `reset --hard <хэш>`, `branch -f своя <хэш>`, `switch -c t <хэш>`, `cherry-pick a..<хэш>`.
    const start = placesAt(sub, args);
    if (start) return start;
  }
  // `bash -c 'git rebase <хэш>'` — тот же перенос в обёртке; `git diff HEAD <хэш> > p` —
  // выгрузка по хэшу (повторная проверка 24.10).
  return (
    wrappedScripts(command)
      .map(syncCandidate)
      .find((start) => start !== undefined) ?? exportSync(command, hashOf)
  );
}

/**
 * Ссылку не назвать до исполнения: подстановка переменной или команды
 * (`"$T"`, `$(cat ref)`, `` `cat ref` ``). Догон с такой целью сверить нечем —
 * его решает человек (повторная проверка 24.10, c).
 */
export function isUnnamedRef(ref: string): boolean {
  return /[$`]/.test(ref);
}

export { conflictsBetween, isHiddenSync, remoteConflicts };

/**
 * Есть ли у HEAD конфликт с целевой веткой, куда ведёт догон `ref`, — по
 * вершине сервера, не по `origin/*` копии (`serverConflicts`, RF-BGCD-05).
 * `base` — база группы: в ней ищется коммит догона по хэшу. Не удалось сверить
 * (ссылки нет, её нет в истории сервера, сервер или git не ответили) — `undefined`.
 */
export async function conflictsWith(
  cwd: string,
  ref: string,
  base?: string,
  run: GitRunner = runGit,
): Promise<boolean | undefined> {
  return serverConflicts(cwd, ref, base, run);
}

/**
 * Что получает модель, когда человек отказал (без своего текста). Английский:
 * читает только модель. Без явного «другим способом нельзя» модель догоняла бы
 * main соседней командой (`merge` вместо `rebase`).
 */
export const MAIN_SYNC_DENIED =
  'Syncing with the target branch is refused: this branch has NO conflicts with it, and the human ' +
  'updates an MR that merely fell behind, on their own word. Do not rebase onto, merge or pull ' +
  'the target branch by any other command, by a hash of its commit, or by re-creating this branch ' +
  'from it (`checkout -B`), and do not force-push to refresh the MR. Writing its content into a file ' +
  'or a directory (a diff or patch, `git show <target>:<file> > …`, an archive, a worktree) is the ' +
  'same sync; to read it, pipe it (`| head`, `| grep`, `| diff - <file>`). ' +
  'Finish the current step on the current base, push as is, ' +
  'and finish the task (no pipeline waiting). Only a real conflict with the target branch is fixed at once.';

/**
 * Конфликт сверить не вышло (ссылки целевой ветки нет локально, старый git):
 * раньше такой догон проходил дальше и решался строками группы — то есть
 * rebase без известного конфликта (решение владельца 23.10: только при конфликте).
 */
export const MAIN_SYNC_UNKNOWN =
  'Syncing with the target branch is refused for now: the panel could not check whether this ' +
  'branch conflicts with it (the target ref is missing locally, is not in the history of the ' +
  'server branch, or the server did not answer). Run `git fetch origin` first, ' +
  'then repeat the same command: with a real conflict it is allowed at once, without one it is ' +
  'refused. Do not rebase onto, merge, pull or re-create the branch from the target branch by any ' +
  'other command (a hash of a target commit, `checkout -B` included). If the refusal repeats after ' +
  'the fetch, the git object store of this copy may be damaged (`git fsck`): say so in the final ' +
  'message instead of working around it.';

/** Запрос прав — догон целевой ветки командой оболочки. */
export function isMainSyncRequest(toolName: string, input: unknown): boolean {
  if (toolName !== 'Bash') return false;
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' && syncsWithTarget(command);
}

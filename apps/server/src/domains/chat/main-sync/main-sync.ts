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

/**
 * Правила `ask` для CLI: в авторежиме без них вызов до брокера не доходит
 * (классификатор CLI пропускает rebase сам). Шире, чем нужно, намеренно —
 * `rebase --continue` тоже придёт к брокеру, но там его пропустит
 * `syncsWithTarget`: правило только ведёт вызов к брокеру, решает он.
 */
export const MAIN_SYNC_ASK: readonly string[] = [
  'Bash(git rebase *)',
  'Bash(git -C * rebase *)',
  'Bash(git pull *)',
  'Bash(git -C * pull *)',
  'Bash(git merge *)',
  'Bash(git -C * merge *)',
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

function segmentSyncs(segment: string): boolean {
  const call = gitCall(segment);
  if (!call) return false;
  const { sub, args } = call;
  if (args.some((a) => IN_PROGRESS.has(a))) return false;
  if (sub === 'rebase' || sub === 'merge') {
    // `--onto <база>` — перенос на названную базу; иначе — первый позиционный.
    const onto = args.indexOf('--onto');
    if (onto >= 0 && isTargetRef(args[onto + 1] ?? '')) return true;
    const ontoEq = args.find((a) => a.startsWith('--onto='));
    if (ontoEq && isTargetRef(ontoEq.slice('--onto='.length))) return true;
    return args.some(isTargetRef);
  }
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

/** Команда переносит ветку на свежую целевую ветку (или вливает её). */
export function syncsWithTarget(command: string): boolean {
  return segments(command).some(segmentSyncs);
}

/**
 * Вся команда — один догон, в своей копии (без `-C` в чужую) и без других
 * звеньев. Только такой при конфликте пропускается без карточки: конфликт
 * группа чинит сразу (правило владельца 19.10), а `git merge origin/main &&
 * git push origin main` в хвосте понёс бы мимо разбора и пуш в main.
 */
export function isSoleSync(command: string): boolean {
  const parts = segments(command);
  return parts.length === 1 && segmentSyncs(parts[0]!) && !/\s-C\s/.test(parts[0]!);
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
    const onto = args.indexOf('--onto');
    if (onto >= 0 && isTargetRef(args[onto + 1] ?? '')) return args[onto + 1];
    const ontoEq = args.find((a) => a.startsWith('--onto='));
    if (ontoEq) return ontoEq.slice('--onto='.length);
    return positional.find(isTargetRef);
  }
  return undefined;
}

/**
 * Есть ли у HEAD конфликт с целевой веткой: `git merge-tree --write-tree`
 * сливает в памяти, рабочую копию не трогает; код 1 — конфликт. Не удалось
 * сверить (старый git, нет ссылки) — `undefined`: решать вслепую нельзя.
 */
export async function conflictsWith(cwd: string, ref: string): Promise<boolean | undefined> {
  const { execFile } = await import('node:child_process');
  const git = (args: string[]): Promise<number | undefined> =>
    new Promise((resolve) => {
      execFile('git', args, { cwd, timeout: 20_000, windowsHide: true }, (error) => {
        if (!error) return resolve(0);
        const code = (error as { code?: unknown }).code;
        resolve(typeof code === 'number' ? code : undefined);
      });
    });
  // Неизвестная ссылка у merge-tree — тоже код 1, как конфликт: сначала проверяем,
  // что она есть, иначе догон по опечатке прошёл бы как «есть конфликт».
  if ((await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== 0) return undefined;
  const code = await git(['merge-tree', '--write-tree', '--quiet', 'HEAD', ref]);
  return code === 0 ? false : code === 1 ? true : undefined;
}

/**
 * Что получает модель, когда человек отказал (без своего текста). Английский:
 * читает только модель. Без явного «другим способом нельзя» модель догоняла бы
 * main соседней командой (`merge` вместо `rebase`).
 */
export const MAIN_SYNC_DENIED =
  'Syncing with the target branch is refused: this branch has NO conflicts with it, and the human ' +
  'updates an MR that merely fell behind, on their own word. Do not rebase onto, merge or pull ' +
  'the target branch by any other command. Finish the current step on the current base, push as is, ' +
  'and finish the task (no pipeline waiting). Only a real conflict with the target branch is fixed at once.';

/** Запрос прав — догон целевой ветки командой оболочки. */
export function isMainSyncRequest(toolName: string, input: unknown): boolean {
  if (toolName !== 'Bash') return false;
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' && syncsWithTarget(command);
}

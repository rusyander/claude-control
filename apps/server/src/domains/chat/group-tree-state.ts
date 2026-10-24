import { git } from '../project-git/exec/exec.ts';
import { groupCommandVerdict } from './group-command/group-command.ts';
import type { GitDiscard } from './group-command/git-guards.ts';
import { collectGitEffects } from './group-command/git-guards.ts';
import { snapshotUncommitted, type Snapshot } from './group-command/git-snapshot.ts';
import { gitSegmentDestroys } from './group-command/git-verdict.ts';
import { parse, UNPARSED } from './group-command/shell-parse.ts';

/**
 * Незакоммиченное копии группы перед командой git, что его сотрёт или унесёт
 * (решения владельца 23.10, «потерь быть не должно, человека не спрашивать»):
 * - затирание (`reset --hard`, `checkout -- пути`, `restore`, `clean -f`) на
 *   грязном дереве — само, но сперва снимок в `refs/agentdeck/backup/…`
 *   (`git-snapshot.ts`); снимок не вышел — отказ агенту, не тихая потеря;
 * - смена ветки на грязном дереве — отказ агенту с порядком владельца: «сперва
 *   доделай и закоммить правки этой ветки, потом переключайся»;
 * - чистое дерево — и то и другое само, без снимка.
 * Грязное — всё, что показывает `git status` (правки, индекс, новые файлы);
 * игнорируемое — нет: его без `-x` git не трогает. Прочитать состояние не
 * вышло — `unknown`, и решение остаётся человеку.
 */
export type GitTree = { dirty: false } | { dirty: true; backup: string } | 'unknown';

export const SWITCH_REFUSAL =
  'The copy has uncommitted changes, so switching branches is refused: finish and commit the ' +
  'current edits on this branch first (a wip commit is fine), then switch. After the commit the ' +
  'old state stays in the history and the reflog. If you meant to restore files rather than ' +
  'switch, put the paths after `--` (git checkout <options> -- <paths>).';

// Снимок не снимается и на неслитом индексе (конфликт слияния/перебазирования):
// там «закоммить» невыполнимо, поэтому отказ называет и выход из слияния (A-19).
export const SNAPSHOT_REFUSAL =
  'This command would discard uncommitted changes, and the panel could not save them first ' +
  '(snapshot under refs/agentdeck/backup/ failed), so it is refused. Commit the current edits ' +
  '(a wip commit is fine), then repeat; after the commit the old state is in the history and ' +
  'the reflog. If a merge, rebase or cherry-pick is in progress (`git status` lists unmerged ' +
  'paths), a commit is not possible yet: resolve the conflicts and `git add` them, or end it ' +
  'with `git merge --abort` / `git rebase --abort` / `git cherry-pick --abort`, first.';

/** Признаки, что строку не разобрать, а git в ней что-то стирает или меняет ветку. */
const UNPARSED_DISCARD =
  /\bgit\b[\s\S]*\b(reset|checkout|switch|restore|clean|rm|stash|read-tree|checkout-index)\b/;

/**
 * Что команда сделает с незакоммиченным (`git-guards.ts`): по разбору звеньев;
 * строку, которую не разобрать, — как худшее из двух, раз проследить нечем.
 */
export function gitDiscards(
  command: string,
  scope: Parameters<typeof groupCommandVerdict>[1],
  recorded: readonly string[] = [],
): GitDiscard[] {
  if (parse(command) === UNPARSED) {
    return UNPARSED_DISCARD.test(command) ? ['discard', 'switch'] : [];
  }
  // Ветка из записи разделения — та же, что у вердикта (`verdictOf`): без неё
  // `branch -f своя` встал бы опасным, разбор остановился бы на нём и смену
  // ветки следующим звеном не увидел.
  return collectGitEffects(() => groupCommandVerdict(command, scope), recorded).discards;
}

/** Не пускает ли состояние дерева команду мимо человека (вызов мимо `guardUncommitted`). */
export function treeBlocks(tree: GitTree | undefined, discards: readonly GitDiscard[]): boolean {
  if (discards.length === 0) return false;
  if (tree === undefined || tree === 'unknown') return true;
  if (!tree.dirty) return false;
  return discards.includes('switch');
}

export interface TreeIo {
  status: (cwd: string) => Promise<string | undefined>;
  snapshot: (cwd: string, command: string) => Promise<Snapshot | undefined>;
  /**
   * В копии есть то, что затирание сотрёт мимо снимка: `true` — решает человек.
   * Не задано — проверки нет (заглушки тестов).
   */
  uncovered?: (cwd: string) => Promise<boolean>;
}

/**
 * Чтение дерева сторожем: новые файлы — все и при любых настройках копии
 * (`status.showUntrackedFiles=no` прятал их, и `clean -fd` сносил их без
 * снимка — ревью 23.10, A-10); подмодули — без `ignore` из настроек.
 */
export const GUARD_STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--porcelain',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=none',
];

/** Настройки, при которых затирание задевает то, чего снимок не держит (A-14, A-15). */
const UNCOVERED_CONFIG = /^(core\.sparsecheckout|submodule\.recurse) (true|yes|on|1)$/im;

/**
 * Что снимок (`git add -A` во временный индекс) не удержит, а затирание сотрёт:
 * - файлы с `assume-unchanged` (`ls-files -v`: строчная буква) — `status` и
 *   `add` их правки не видят, `reset --hard` их стирает (A-16);
 * - разреженная копия — файлы вне конуса снимок не держит (A-15);
 * - `submodule.recurse=true` — затирание спустится в подмодули (A-14).
 * Не прочиталось — тоже `true`: без знания решает человек.
 */
async function realUncovered(cwd: string): Promise<boolean> {
  try {
    const config = await git(
      cwd,
      ['config', '--bool', '--get-regexp', '^(core\\.sparsecheckout|submodule\\.recurse)$'],
      10_000,
    ).catch(() => '');
    if (UNCOVERED_CONFIG.test(config)) return true;
    const listed = await git(cwd, ['ls-files', '-v', '-z'], 10_000);
    return listed.split('\0').some((entry) => /^[a-z] /.test(entry));
  } catch {
    return true;
  }
}

const realTreeIo: TreeIo = {
  status: (cwd) => git(cwd, GUARD_STATUS_ARGS, 10_000).catch(() => undefined),
  snapshot: (cwd, command) => snapshotUncommitted(cwd, command),
  uncovered: realUncovered,
};

/**
 * Игнорируемое меняется в этой же команде перед `clean` (`printf … > .gitignore
 * && git clean -fd`, `git config core.excludesFile …; git clean -fd`): снимок
 * снимается до команды и игнорируемого не держит, а `clean` его уже сотрёт
 * (A-12). Отдельной командой то же безопасно: снимок увидит файлы новыми.
 */
const REWRITES_IGNORES = /\.gitignore|info[\\/]+exclude|excludesfile/i;

export function rewritesIgnores(command: string): boolean {
  return /\bclean\b/.test(command) && REWRITES_IGNORES.test(command);
}

/**
 * Живое состояние копии перед командой, что стирает или уносит незакоммиченное:
 * `{ tree }` — идти дальше (правила группы решат, снимок уже лежит), `{ deny }` —
 * отказ агенту с причиной. Команде без такого звена дерево не читается.
 */
export async function guardUncommitted(
  worktree: string | undefined,
  command: string,
  discards: readonly GitDiscard[],
  io: TreeIo = realTreeIo,
): Promise<{ tree?: GitTree } | { deny: string }> {
  if (discards.length === 0) return {};
  if (!worktree) return { tree: 'unknown' };
  if (discards.includes('discard')) {
    if (rewritesIgnores(command)) return { tree: 'unknown' };
    if (io.uncovered && (await io.uncovered(worktree))) return { tree: 'unknown' };
  }
  const status = await io.status(worktree);
  if (status === undefined) return { tree: 'unknown' };
  if (status.replace(/\0/g, '').trim() === '') return { tree: { dirty: false } };
  if (discards.includes('switch')) return { deny: SWITCH_REFUSAL };
  const snapshot = await io.snapshot(worktree, command);
  if (!snapshot) return { deny: SNAPSHOT_REFUSAL };
  return { tree: { dirty: true, backup: snapshot.ref } };
}

/** Признаки удаления и слияния в строке, которую не разобрать. */
// Склеенные короткие (`-fd`, `-qD`, `-dq`) и сокращённые длинные (`--del`,
// `--pru`, `--mir`) — то же, что `-d` (ревью 23.10, A-21).
const UNPARSED_DESTROYS =
  /\bgit\b[\s\S]*(\bmerge\b|\bbranch\b[\s\S]*\s(-[a-zA-Z]*[dDMCf][a-zA-Z]*|--d[a-z]*|--mo[a-z]*|--co[a-z]*|--fo[a-z]*)\b|\btag\b[\s\S]*\s(-[a-zA-Z]*d[a-zA-Z]*|--d[a-z]*)\b|\bclean\b|\bfilter-(branch|repo)\b|\breflog\s+(expire|delete)\b|\bgc\b[\s\S]*--prune|\bupdate-ref\b[\s\S]*(\s(-[a-zA-Z]*d[a-zA-Z]*|--d[a-z]*|--stdin)\b|refs\/heads\/)|\bworktree\s+(remove|prune)\b|\bstash\s+(drop|clear)\b|\bsymbolic-ref\b[\s\S]*\s-[a-zA-Z]*d|\bpush\b[\s\S]*(--d[a-z]*|--pru[a-z]*|--m[a-z]*|\s-[a-zA-Z0-9]*d[a-zA-Z0-9]*\b|\s\+?:\S))/;

/**
 * Удаляет ли команда данные git или сливает ветки — для одиночного чата
 * (решение владельца 23.10: «даже если это не группа, а одиночная задача»):
 * такое авторежим чата не пропускает, решает человек.
 */
export function gitDestroys(toolName: string, input: unknown): boolean {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return false;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return false;
  return toolName === 'Bash' ? bashDestroys(command) : powershellDestroys(command);
}

/** Звено — простой `git …`: его судит разбор, слова по нему не смотрим. */
const PS_PLAIN_GIT = /^\s*git\s[^`]*$/;

/**
 * Строка инструмента PowerShell (I-08). Простые кавычки PowerShell и Bash читают
 * одинаково, поэтому `git …` судит тот же разбор — после того как имя git
 * сведено к одному (`Git.exe` — тот же git), а типографское тире — к дефису.
 * Где git не первое слово (`Start-Process git -ArgumentList 'branch','-D','x'`,
 * `iex 'git merge side'`) или в строке обратная кавычка PowerShell, разбор его не
 * видит: такое звено судится словами, кавычки и запятые списка — разделители.
 * Лишнее задетое уходит человеку, а не мимо него.
 */
function powershellDestroys(command: string): boolean {
  const named = command.replace(/\bgit(?:\.exe)?\b/gi, 'git').replace(/[\u2013-\u2015]/g, '-');
  if (bashDestroys(named)) return true;
  return named
    .split(/[;\n\r|&]+/)
    .some(
      (part) =>
        !PS_PLAIN_GIT.test(part) &&
        UNPARSED_DESTROYS.test(part.replace(/[`'",\u2018-\u201E]/g, ' ')),
    );
}

/** Звено запускает другую программу или строку: имя исполняемого — не первое слово. */
const PS_LAUNCHER =
  /\b(start-process|saps|start|iex|invoke-expression|invoke-command|icm|cmd(?:\.exe)?|pwsh(?:\.exe)?|powershell(?:\.exe)?|bash(?:\.exe)?|sh|wsl(?:\.exe)?)\b/i;
/** Рекурсивное удаление cmd/PowerShell словами: `rd /s`, `rmdir /s`, `del /s`, `Remove-Item -Recurse`. */
const PS_RECURSIVE_DELETE =
  /\b(rd|rmdir|del|erase)\b[\s\S]*\/s\b|\b(remove-item|rm|ri|rmdir|del)\b[\s\S]*\s-r[a-z]*\b|\brm\b[\s\S]*\s-[a-z]*r[a-z]*\b/i;

/**
 * Звено инструмента PowerShell, что запускает git или удаление чужими руками
 * (`Start-Process git -ArgumentList 'branch','-D','x'`, `Start-Process cmd '/c rd /s /q src'`,
 * `iex 'git push …'`) — для строк группы (P-02, R1). Разбор такое звено не видит:
 * `groupDecision` пропускал его строкой «обычная работа». Решает человек; простой
 * `git …` первым словом судит разбор, как и прежде.
 */
export function powershellLaunchDestroys(command: string): boolean {
  const named = command.replace(/\bgit(?:\.exe)?\b/gi, 'git').replace(/[–-―]/g, '-');
  return named.split(/[;\n\r|&]+/).some((part) => {
    if (PS_PLAIN_GIT.test(part) || !PS_LAUNCHER.test(part)) return false;
    const words = part.replace(/[`'",‘-„]/g, ' ');
    return (
      UNPARSED_DESTROYS.test(words) ||
      /\bgit\b[\s\S]*\bpush\b/.test(words) ||
      PS_RECURSIVE_DELETE.test(words)
    );
  });
}

function bashDestroys(command: string): boolean {
  const steps = parse(command);
  if (steps === UNPARSED) return UNPARSED_DESTROYS.test(command);
  if (collectGitEffects(() => groupCommandVerdict(command, {})).destroys) return true;
  // Разбор встаёт на первом опасном звене — следующие звенья смотрим сами.
  return steps.some((step) => {
    if (typeof step === 'symbol') return false;
    const start = step.words.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word.text));
    const words = start < 0 ? [] : step.words.slice(start);
    return words[0]?.text === 'git' && gitSegmentDestroys(words);
  });
}

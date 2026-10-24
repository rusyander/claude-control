import {
  GROUP_REQUEST_IDS,
  resolveGroupPermissions,
  type GroupPermissionLevel,
  type GroupRequestId,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import type { StoredSplitSettings } from '@agentdeck/contracts/task-split';
import type { SplitAutoNotice, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { planTreeKill, type ProcessRow } from '../../lib/kill-tree.mjs';
import { readCommandTable } from '../../lib/process-tree/path-sweep.ts';
import { readMarks } from '../../lib/process-tree/process-env-mark.ts';
import { git } from '../project-git/exec/exec.ts';
import { findPortHolders } from '../project-runner/ports.ts';
import { isReadOnlyTool, ruleFor, shouldAutoApprove } from './auto-approve/auto-approve.ts';
import {
  copyRootOf,
  prunableWorktrees,
  realWorktreeListIo,
  recordBranchCopy,
  type WorktreeListIo,
} from './group-copy-root.ts';
import {
  groupCommandVerdict,
  ignoredFacts,
  isProtectedBranch,
  powershellToolStorage,
  type GroupCommandScope,
  type GroupCommandVerdict,
  type KillTargets,
} from './group-command/group-command.ts';
import { collectGitEffects, type GitDiscard } from './group-command/git-guards.ts';
import {
  groupProcessMark,
  processLabel,
  provenOwn,
  type OwnerEvidence,
  type OwnerRow,
} from './group-process-owner.ts';
import {
  gitDiscards,
  powershellLaunchDestroys,
  treeBlocks,
  type GitTree,
} from './group-tree-state.ts';
import { shellAliases, shellFunctions, type ShellAliases } from './shell-aliases.ts';
import type { ShellFunctions } from './shell-functions.ts';

/**
 * Разрешения группы разделения — строки вкладки «Группы».
 *
 * Группу панель ведёт без человека: её прогон заводит конвейер, а не сообщение
 * из браузера, и тумблера автоподтверждения у такого прогона нет. Раньше это
 * значило «спрашивать всё, кроме чтения», и группа вставала карточкой на
 * первом же коммите, пока человек смотрел в другую вкладку. Теперь решение
 * берётся из строк группы: `auto` решается сама, `notify` — сама, но с
 * отметкой в хабе родителя, `human` — карточкой человеку.
 *
 * Тумблер, ВКЛЮЧЁННЫЙ человеком в чате группы (он написал туда сам), сильнее:
 * это уже разговор человека, и в нём действует то, что он видит в шапке.
 * Унаследованный от родителя тумблер строкам не мешает.
 */

export interface GroupPermissionSource {
  getChatLink(
    chatId: string,
  ): { parentChatId: string; groupIndex?: number; branch?: string } | undefined;
  getSplitPlan(parentChatId: string):
    | {
        projectPath: string;
        request: { allowEdits?: boolean };
        groups: { index: number; branch: string; mr?: string }[];
      }
    | undefined;
  getSplitSettings(path: string): StoredSplitSettings;
  getSplitDefaults(): SplitDefaults;
}

export interface GroupAutoApprove {
  /** Действующие строки проекта группы: своё поверх общего. */
  rows: Record<GroupRequestId, GroupPermissionLevel>;
  /** Правки разрешены запросом разделения — иначе группа «только чтение». */
  allowEdits: boolean;
  /** Ветка группы из записи разделения. Для решения о пуше — не она, а `ownBranch`. */
  branch?: string;
  /** Копия группы — корень копии над каталогом прогона (`withWorktree`, `copyRootOf`). */
  worktree?: string;
  /**
   * Своя ветка группы — та, на которой копия стоит по git (`withWorktree`), если
   * она не основная; HEAD отсоединена — ветка из записи разделения. Из текста
   * команды не берётся никогда: группа могла завести ветку по правилу проекта, а
   * не ту, что в записи разделения.
   */
  ownBranch?: string;
  /** Ветка по умолчанию у `origin` — защищена, как `main` (`withWorktree`). */
  base?: string;
  /**
   * Игнорируемое невременное копии (`withWorktree`, только для команд с удалением
   * или перезаписью файлов): то, чего git не вернёт. Без него удаление
   * невременного решает человек.
   */
  ignored?: string[];
  /**
   * Копии, чьи записи снесёт `git worktree prune` сейчас (`withWorktree`, только
   * для команд с ним). Без него `prune` решает человек.
   */
  prunable?: string[];
  /** MR группы из записи разделения: у ветки на ревью исключения нет (L7.12). */
  mr?: string;
  /**
   * MR группы открыт и снят с черновика — по форджу, прочитан маршрутом прав
   * перед решением (`needsMrState`). `undefined` — не читали или прочитать не
   * удалось: при известном MR это «на ревью» (решает человек).
   */
  mrInReview?: boolean;
  /**
   * Ветка MR конфликтует с целевой — по форджу или по `git merge-tree` между
   * `origin/<своя>` и `origin/<целевая>` (маршрут прав, вместе с `mrInReview`).
   * `undefined` — не читали или узнать не удалось: конфликт не известен.
   */
  mrConflicts?: boolean;
  /**
   * Каталог оболочки CLI перед этой командой — из транскрипта (`toolCallCwd`).
   * Разбор начинает с него, только если он внутри копии (`walk.ts` `startDir`).
   */
  shellCwd?: string;
  /**
   * Рабочая папка CLI этой сессии группы (`sessionScratchpad`): удаление в ней —
   * уборка своего (F-77). `undefined` — своей папки не знаем, удаление вне копии
   * решает человек.
   */
  scratchpad?: string;
  /**
   * Псевдонимы оболочки Bash-инструмента — из снимка оболочки CLI (`withWorktree`,
   * `shell-aliases.ts`): `gp` из `.bashrc` раскрывается до суда. `undefined` —
   * снимка нет: имя судится, как написано.
   */
  aliases?: ShellAliases;
  /**
   * Функции того же снимка (`.bashrc`, повторная проверка 24.10): вызов функции
   * судится по её телу (`group-command.ts` `functionVerdict`). `undefined` —
   * снимка или функций нет.
   */
  functions?: ShellFunctions;
  /**
   * Свои процессы группы среди целей погашения (`withProcessFacts`, только для
   * команд, гасящих номер или порт): живое дерево CLI, метка группы в окружении,
   * сирота с текстом запуска из транскрипта копии (`group-process-owner.ts`).
   * `undefined` — снимок не удался: погашение отказывается агенту.
   */
  ownPids?: ReadonlySet<number>;
  /** Кто слушает порты, которые команда гасит (`withProcessFacts`). */
  portHolders?: ReadonlyMap<number, readonly number[]>;
  /** Подписи целей для отказа агенту: номер → командная строка (`withProcessFacts`). */
  processLabels?: ReadonlyMap<number, string>;
  /**
   * Незакоммиченное копии перед командой, что его сотрёт или унесёт
   * (`guardUncommitted`): чистое, грязное и уже снятое в `refs/agentdeck/backup/…`
   * или не прочитанное. `undefined` — не читали: такое звено решает человек.
   */
  tree?: GitTree;
  /** Разделение и номер группы — куда писать отметку «разрешено автоматически». */
  parentChatId: string;
  groupIndex: number;
}

/**
 * Строки группы для прогона, или `undefined` — это не группа разделения.
 * Ключей несколько: прогон может жить под временным `new-…`, а связь записана
 * уже под идентификатором сессии, или наоборот.
 */
export function groupAutoApproveFor(
  source: GroupPermissionSource,
  keys: readonly (string | undefined)[],
): GroupAutoApprove | undefined {
  for (const key of keys) {
    if (!key) continue;
    const link = source.getChatLink(key);
    if (!link?.parentChatId) continue;
    const plan = source.getSplitPlan(link.parentChatId);
    // Связь бывает и у звеньев каскада обычного чата: группой считаем только
    // то, что нашлось в записи разделения по номеру или ветке.
    const isGroup = plan?.groups.some(
      (group) =>
        group.index === link.groupIndex || (Boolean(link.branch) && group.branch === link.branch),
    );
    const group = plan?.groups.find(
      (entry) =>
        entry.index === link.groupIndex || (Boolean(link.branch) && entry.branch === link.branch),
    );
    if (!plan || !isGroup || !group) continue;
    const stored = source.getSplitSettings(plan.projectPath);
    return {
      rows: resolveGroupPermissions(source.getSplitDefaults().permissions, stored.permissions),
      allowEdits: plan.request.allowEdits === true,
      branch: group.branch || link.branch,
      ...(group.mr ? { mr: group.mr } : {}),
      parentChatId: link.parentChatId,
      groupIndex: group.index,
    };
  }
  return undefined;
}

/**
 * Нужна ли команде своя ветка копии: пуш — да; слияние — тоже (догон основной
 * в СВОЮ рабочую ветку — рутина, в основную или защищённую — человеку);
 * перестановка ветки (`branch -f`, `checkout -B`, `switch -C`, `update-ref`) —
 * только своей, её и надо знать.
 */
function needsBranch(command: string): boolean {
  return (
    /\bgit\b[\s\S]*\b(push|merge|branch|update-ref|symbolic-ref|checkout|switch)\b/.test(command) ||
    // Загрузка в следящую ссылку своей ветки — только из неё же (`forgesTracking`).
    /\bgit\b[\s\S]*\b(fetch|pull)\b[\s\S]*:(refs\/)?remotes\//.test(command)
  );
}

/** Команде нужен список копий, которые снесёт `git worktree prune` (`prunableWorktrees`). */
function needsPrunable(command: string): boolean {
  return /\bgit\b[\s\S]*\bworktree\b[\s\S]*\bprune\b/.test(command);
}

/** Текст команды и значения псевдонимов и тела функций, чьи имена в нём стоят словом. */
function withAliasText(
  command: string,
  aliases: ShellAliases | undefined,
  functions?: ShellFunctions,
): string {
  const words = new Set(command.split(/[\s;&|()]+/));
  const values = [aliases, functions].flatMap((names) =>
    names
      ? Object.keys(names)
          .filter((name) => words.has(name))
          .map((name) => names[name])
      : [],
  );
  return values.length > 0 ? `${command}\n${values.join('\n')}` : command;
}

/**
 * Нужен ли команде список игнорируемого копии: удаление или перезапись файлов
 * (`rm`, `git checkout -- …`, `git restore`, `find -delete`). Без него
 * невременное удаление решает человек.
 */
function needsIgnored(command: string): boolean {
  return /(^|[\s;&|(`'"])(rm|rmdir|rd|del|erase|unlink|shred|remove-item)(\s|$)|\bgit\b[\s\S]*\b(restore|checkout|rm)\b|\s-delete\b/i.test(
    command,
  );
}

/**
 * Копия и своя ветка группы — у git копии, а не из команды (просьба владельца
 * 19.10). Git читается только когда в команде пуш: на каждое разрешение
 * процесс не нужен. Ветка основная или защищённая (`main`, `master`,
 * `develop`, `release/…`, ветка по умолчанию у `origin`) — своей ветки нет, и
 * пуш без явной цели уходит человеку. HEAD отсоединена или git не ответил —
 * своя ветка из записи разделения (`branch`), если она есть и не защищена.
 */
export async function withWorktree(
  group: GroupAutoApprove,
  cwd: string | undefined,
  request: { toolName: string; input: unknown },
  worktrees: WorktreeListIo = realWorktreeListIo,
  aliasesOf: () => Promise<ShellAliases | undefined> = shellAliases,
  functionsOf: () => Promise<ShellFunctions | undefined> = shellFunctions,
): Promise<GroupAutoApprove> {
  if (!cwd) return group;
  // Прогон в подпроекте копии — копия всё равно вся (`copyRootOf`). Прогон
  // записан в основной копии, а копия ветки записи у репозитория есть — своя
  // она, а не основная (`recordBranchCopy`, решение 23.10).
  const top = copyRootOf(cwd);
  const root = (await recordBranchCopy(top, group.branch, worktrees)) ?? top;
  // Псевдонимы — только у Bash: снимок оболочки CLI делается для него.
  const bash = request.toolName === 'Bash';
  const aliases = bash ? await aliasesOf().catch(() => undefined) : undefined;
  const functions = bash ? await functionsOf().catch(() => undefined) : undefined;
  const written = shellCommandOf(request);
  // Какие факты нужны, решает текст вместе с развёрткой псевдонимов и телами
  // функций: `gp` — это `git push`.
  const command = written === undefined ? undefined : withAliasText(written, aliases, functions);
  const ignored =
    command && needsIgnored(command)
      ? await git(
          root,
          ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
          5_000,
        )
          .then(ignoredFacts)
          .catch(() => undefined)
      : undefined;
  const prunable =
    command && needsPrunable(command) ? await prunableWorktrees(root, worktrees) : undefined;
  const placed = {
    ...group,
    worktree: root,
    ...(ignored ? { ignored } : {}),
    ...(prunable ? { prunable } : {}),
    ...(aliases && Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(functions && Object.keys(functions).length > 0 ? { functions } : {}),
  };
  if (!command || !needsBranch(command)) return placed;
  const read = async (args: string[]): Promise<string> =>
    (await git(root, args, 5_000).catch(() => '')).trim();
  const [branch, remoteHead] = await Promise.all([
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  const base = remoteHead.replace(/^origin\//, '');
  const known = base ? { ...placed, base } : placed;
  // HEAD отсоединена (проверка догона `checkout --detach && merge origin/main`,
  // повтор 23.10: 26 пушей арендой `HEAD:<своя ветка>` уходили человеку) —
  // своя ветка та, что панель завела группе по записи разделения.
  const own = branch || group.branch;
  if (!own || isProtectedBranch(own, base)) return known;
  return { ...known, ownBranch: own };
}

function scopeOf(group: GroupAutoApprove): GroupCommandScope {
  return {
    ...(group.worktree ? { worktree: group.worktree } : {}),
    ...(group.shellCwd ? { cwd: group.shellCwd } : {}),
    ...(group.scratchpad ? { scratchpad: group.scratchpad } : {}),
    ...(group.ownBranch ? { branch: group.ownBranch } : {}),
    ...(group.base ? { base: group.base } : {}),
    ...(group.ignored ? { ignored: group.ignored } : {}),
    ...(group.prunable ? { prunable: group.prunable } : {}),
    ...(group.aliases ? { aliases: group.aliases } : {}),
    ...(group.functions ? { functions: group.functions } : {}),
  };
}

function verdictOf(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): GroupCommandVerdict | undefined {
  const command = shellCommandOf(request);
  if (command === undefined) return undefined;
  // Ветка группы из записи разделения — тоже своя для перестановки (`ownsBranch`).
  const recorded = group.branch ? [group.branch] : [];
  return collectGitEffects(() => groupCommandVerdict(command, scopeOf(group)), recorded).result;
}

/**
 * Разбор счёл команду догона опасной (глобальный ключ с программой, `-x <команда>`,
 * вливание не базы) — её не пропускает и короткий путь «догон при конфликте».
 */
export function syncDanger(group: GroupAutoApprove, command: string, toolName = 'Bash'): boolean {
  return verdictOf(group, { toolName, input: { command } })?.kind === 'danger';
}

/** Сотрёт или унесёт ли команда незакоммиченное копии (`group-tree-state.ts`). */
export function groupDiscards(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): GitDiscard[] {
  const command = shellCommandOf(request);
  const recorded = group.branch ? [group.branch] : [];
  return command === undefined ? [] : gitDiscards(command, scopeOf(group), recorded);
}

/**
 * Пуш арендой своей ветки, у которой уже есть MR (журнал 19.10 02:17:02,
 * L7.12): доставленная группа после пустого rebase переписала ветку MR, снятого
 * с черновика и стоявшего на ревью, — исключение W3-3 пропустило это молча.
 * Исключение писалось для ветки, которую группа ещё доводит до MR; ветку, что
 * читают ревьюеры, затирает только человек. Состояние MR знает лишь фордж —
 * маршрут прав читает его, когда этот вопрос задан (`true`), и кладёт в
 * `mrInReview`. Черновик — исключение действует, как прежде.
 */
export function needsMrState(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): boolean {
  if (!group.mr) return false;
  const verdict = verdictOf(group, request);
  return verdict !== undefined && verdict.kind !== 'danger' && verdict.lease;
}

/**
 * Отказ агенту, а не карточка: перезапись своей ветки, чей MR на ревью, без
 * конфликта с целевой (решение владельца 23.10 — rebase и обновление MR только
 * при конфликте). Человеку тут решать нечего: ветка конфликт-свободна, пуш
 * лишь сдвинул бы дифф под ревьюерами. Фордж не ответил — конфликт не известен,
 * тоже отказ: причина говорит, как проверить самому. `undefined` — не этот случай.
 */
export function groupPushRefusal(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): string | undefined {
  const verdict = verdictOf(group, request);
  if (!verdict || verdict.kind === 'danger' || !verdict.lease) return undefined;
  if (!branchUnderReview(group) || group.mrConflicts === true) return undefined;
  const known =
    group.mrConflicts === false
      ? 'The MR of this branch is in review and has no conflict with its target branch'
      : 'The MR of this branch is in review and no conflict with its target branch is known (the forge state could not be read)';
  return (
    `${known}, so rewriting the branch (force / lease push) is refused: rebase and MR refresh ` +
    'happen only on a conflict (owner policy). Push new commits with a plain `git push`. ' +
    'If you believe there is a conflict, check it with `git fetch origin && git merge-tree ' +
    '--write-tree --name-only origin/<own branch> origin/<target>`: exit code 1 with ' +
    '`CONFLICT` lines is a conflict, exit code 0 is none. On a real conflict resolve it and ' +
    'the lease push is allowed.'
  );
}

const LEVEL_ORDER: readonly GroupPermissionLevel[] = ['auto', 'notify', 'human'];

function strictest(levels: GroupPermissionLevel[]): GroupPermissionLevel {
  return levels.reduce((a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a), 'auto');
}

/**
 * Правила чата по звеньям, которые разбор не узнал: каждое судится по своему
 * тексту, а не вся строка. `grep "drop table"` и тело `cat > x.sql <<EOF` — чтение
 * и запись файла, не снос базы.
 */
function otherRules(verdict: Extract<GroupCommandVerdict, { kind: 'other' }>): GroupRequestId[] {
  const ids: GroupRequestId[] = [...verdict.rules];
  for (const text of verdict.texts) {
    const rule = ruleFor('Bash', { command: text });
    // `editInMainCopy` у Bash не бывает: его ставит маршрут правок файлов.
    ids.push(rule && rule !== 'editInMainCopy' ? rule : 'routine');
  }
  return ids;
}

/**
 * Всё, что команда гасит, — свои процессы группы: каждый номер и каждый
 * держатель каждого порта. Порт, который никто не держит, гасить нечего — он
 * не мешает (D-1, 24.10: раньше это было «своё не доказано»). Снимка нет или
 * цель без имени — своё не доказано.
 */
function killsOwnOnly(group: GroupAutoApprove, kills: KillTargets): boolean {
  if (kills.unnamed) return false;
  const own = group.ownPids;
  if (!own) return false;
  if (!kills.pids.every((pid) => own.has(pid))) return false;
  if (kills.ports.length > 0 && !group.portHolders) return false;
  return kills.ports.every((port) =>
    (group.portHolders?.get(port) ?? []).every((pid) => own.has(pid)),
  );
}

/** Команда для агента: как погасить своё, чтобы суд узнал цель. */
const KILL_OWN_HOWTO =
  'Stop only what you started, named by number: `kill $!` right after you launched it, or by its port — ' +
  '`for p in $(netstat -ano | grep ":PORT " | grep LISTENING | awk \'{print $5}\' | sort -u); do taskkill //PID $p //F; done` ' +
  '(Windows) or `kill $(lsof -t -iTCP:PORT -sTCP:LISTEN)` (Linux/macOS).';

/**
 * Отказ агенту вместо карточки человеку (D-1, 24.10, решение владельца: такие
 * вызовы человек не решает): погашение не своего или неназванного. Ничего из
 * команды не исполнилось — агенту сказано, что повторить без погашения.
 * `undefined` — погашения нет или всё гасимое своё.
 */
export function groupKillRefusal(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): string | undefined {
  const verdict = verdictOf(group, request);
  if (!verdict || verdict.kind === 'danger' || !verdict.kills) return undefined;
  const kills = verdict.kills;
  if (killsOwnOnly(group, kills)) return undefined;
  const rest =
    'Nothing in this command ran: re-run what you still need without the stop, as separate commands.';
  if (kills.unnamed) {
    return `This command stops a process it does not name by number (an image name, a pattern, a pid read at run time, or a line the panel cannot parse), so the panel cannot tell it is yours. ${KILL_OWN_HOWTO} ${rest}`;
  }
  if (!group.ownPids || (kills.ports.length > 0 && !group.portHolders)) {
    return `The panel could not read the process table to confirm the target is yours. Retry once; if it repeats, leave the process running and use another port. ${rest}`;
  }
  const own = group.ownPids;
  const label = (pid: number) =>
    `pid ${pid} (${group.processLabels?.get(pid) ?? 'not in the process table'})`;
  const foreign = [
    ...kills.pids.filter((pid) => !own.has(pid)).map(label),
    ...kills.ports.flatMap((port) =>
      (group.portHolders?.get(port) ?? [])
        .filter((pid) => !own.has(pid))
        .map((pid) => `port ${port} held by ${label(pid)}`),
    ),
  ];
  return `This group did not start ${foreign.join('; ')}: it belongs to the owner, the panel or another group. Do not stop it — run your own server on another free port (e.g. \`--port <free> --strictPort\`). ${rest}`;
}

/** Что команда гасит — номера и порты (N3), или `undefined`: не гасит ничего числом. */
export function killTargetsOf(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): KillTargets | undefined {
  const verdict = verdictOf(group, request);
  return verdict && verdict.kind !== 'danger' ? verdict.kills : undefined;
}

/** Снимок процессов, держатели портов, метки окружения — подменяемы в тесте (граница ОС). */
export interface ProcessFactsIo {
  readTable: () => Promise<readonly OwnerRow[] | undefined>;
  portHolders: (port: number) => number[];
  readMarks?: (
    rows: readonly ProcessRow[],
    name: string,
  ) => Promise<ReadonlyMap<number, boolean> | undefined>;
  ran?: OwnerEvidence['ran'];
  platform?: string;
}

const realProcessIo: ProcessFactsIo = {
  readTable: () => readCommandTable(),
  portHolders: findPortHolders,
  readMarks: (rows, name) => readMarks(rows, name),
};

/**
 * Свои процессы группы среди целей — только когда команда гасит номер или порт
 * (N3): снимок с командными строками стоит ~1 с, на каждое разрешение он не
 * нужен. Своё — потомки корней прогона (посредник, оболочка, сам CLI:
 * `processRootsOf`) по тому же обходу, что снимает дерево (`planTreeKill`), и
 * сироты, доказанные меткой группы или текстом запуска (`provenOwn`, D-1):
 * корней может и не быть (прогон закончил ход — пересуд D-n при старте).
 * Снимок не удался — фактов нет, и погашение отказывается агенту.
 */
export async function withProcessFacts(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
  roots: readonly number[],
  io: ProcessFactsIo = realProcessIo,
  evidence: { transcriptDir?: string } = {},
): Promise<GroupAutoApprove> {
  const kills = killTargetsOf(group, request);
  if (!kills || kills.pids.length + kills.ports.length === 0) return group;
  const table = await io.readTable().catch(() => undefined);
  if (!table) return group;
  const tree = new Set<number>();
  for (const root of roots) for (const pid of planTreeKill([...table], root).pids) tree.add(pid);
  const portHolders = new Map<number, number[]>();
  for (const port of kills.ports) portHolders.set(port, io.portHolders(port));
  const targets = [...new Set([...kills.pids, ...[...portHolders.values()].flat()])];
  const candidates = table.filter((row) => targets.includes(row.pid) && !tree.has(row.pid));
  const marks =
    candidates.length > 0 && io.readMarks
      ? await io
          .readMarks(candidates, groupProcessMark(group.parentChatId, group.groupIndex))
          .catch(() => undefined)
      : undefined;
  const own = provenOwn(table, targets, {
    tree,
    ...(marks ? { marks } : {}),
    ...(evidence.transcriptDir ? { transcriptDir: evidence.transcriptDir } : {}),
    ...(io.ran ? { ran: io.ran } : {}),
    ...(io.platform ? { platform: io.platform } : {}),
  });
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const processLabels = new Map(
    targets.filter((pid) => byPid.has(pid)).map((pid) => [pid, processLabel(byPid.get(pid))]),
  );
  return { ...group, ownPids: own, portHolders, processLabels };
}

/** MR известен, а снят ли с черновика — нет (не читали, сбой форджа): считаем «на ревью». */
function branchUnderReview(group: GroupAutoApprove): boolean {
  return Boolean(group.mr) && group.mrInReview !== false;
}

function commandOf(input: unknown): string | undefined {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * Строка оболочки, которую судит разбор: у Bash — команда как есть, у
 * инструмента PowerShell — как `pwsh -Command '<текст>'` в Bash (раунд 10, 24.10).
 * Раньше инструмент PowerShell разбирался только на хранилище git, и
 * `Remove-Item -Recurse -Force C:/Users/me/Documents` или `git push origin
 * HEAD:main --force` шли сами; обёрткой — те же цели, пуши и обёртки, что у Bash.
 */
function shellCommandOf(request: { toolName: string; input: unknown }): string | undefined {
  const command = commandOf(request.input);
  if (command === undefined) return undefined;
  if (request.toolName === 'Bash') return command;
  if (request.toolName !== 'PowerShell') return undefined;
  return `pwsh -NoProfile -Command '${command.replace(/'/g, `'\\''`)}'`;
}

/**
 * Как решён запрос группы: `human` — карточкой человеку, `auto` — молча,
 * `notify` — сам, но с отметкой в хабе. Именованное правило решает своя
 * строка; всё прочее, кроме чтения, — строка «обычная работа». Остальные
 * предохранители (`ask`/`deny` из settings.json, «только чтение») — те же, что
 * у чата: их держит `shouldAutoApprove`.
 */
export function groupDecision(
  group: GroupAutoApprove,
  request: {
    toolName: string;
    input: unknown;
    guardedPatterns: string[];
    allowedTools?: ReadonlySet<string>;
  },
): GroupPermissionLevel {
  const ruled = ruleFor(request.toolName, request.input);
  // MCP-инструмент, разрешённый человеком по имени, для строк группы — чтение:
  // свой список `allow` к серверу под `ask` (L6.2) CLI уже не применяет.
  const allowedByName =
    ruled === 'externalWrite' && request.allowedTools?.has(request.toolName) === true;
  const read = isReadOnlyTool(request.toolName) || allowedByName;
  const named = allowedByName ? undefined : ruled;
  // Правка основной копии — не строка группы: группа пишет только в своей.
  if (named === 'editInMainCopy') return 'human';
  // Инструмент PowerShell: запись (или что угодно) по пути хранилища git уводит
  // пуш и ставит крючки — человеку, как `pwsh -c` в Bash (раунд 8).
  if (request.toolName === 'PowerShell') {
    const command = commandOf(request.input);
    if (command !== undefined && powershellToolStorage(command, scopeOf(group))) return 'human';
    // git или удаление внутри `Start-Process`/`iex`/`cmd /c` — разбор их не видит (R1).
    if (command !== undefined && powershellLaunchDestroys(command)) return 'human';
  }
  const rows = group.rows;
  // Команда оболочки разобрана по звеньям (`group-command.ts`): опасное —
  // человеку при любых строках, рутина своей копии — строкой пуша/коммита или
  // «обычной работы», прочее — правилами чата ниже.
  const verdict = verdictOf(group, request);
  if (verdict?.kind === 'danger') return 'human';
  // Затирание или смена ветки без прочитанного дерева, смена ветки на грязном
  // (маршрут прав отказал бы раньше, `guardUncommitted`) — человеку.
  if (verdict && treeBlocks(group.tree, groupDiscards(group, request))) return 'human';
  // Погашение не своего процесса или порта (N3: 23.10 группа сняла по номерам из
  // netstat dev-серверы на :5173-5175, порт стенда владельца) маршрут прав
  // отказывает агенту раньше (`groupKillRefusal`); здесь — страховка вызова мимо.
  if (verdict?.kills && !killsOwnOnly(group, verdict.kills)) return 'human';
  if (verdict) {
    // Перезапись своей ветки, чей MR на ревью (L7.12), затирает то, что читают
    // ревьюеры: только ради снятого конфликта, и тогда сама — с отметкой (решение
    // владельца 23.10). Без конфликта маршрут прав отказывает агенту раньше
    // (`groupPushRefusal`); здесь — на случай вызова мимо него.
    if (verdict.lease && branchUnderReview(group)) {
      return group.mrConflicts === true ? 'notify' : 'human';
    }
    // Уборка и восстановимое удаление — строкой «удаление файлов», пуш и
    // коммит — «записью в git»; прочие звенья — правилом чата по их тексту.
    const ids: GroupRequestId[] = verdict.kind === 'other' ? otherRules(verdict) : [];
    if (verdict.writes) ids.push('gitWrite');
    if (verdict.deletes) ids.push('filesDelete');
    const level = strictest(ids.length > 0 ? ids.map((id) => rows[id]) : [rows.routine]);
    if (level === 'human') return 'human';
    // Правило чата по всей строке здесь не решает (оно видело `--force` в
    // `--force-with-lease` и «drop» в сообщении коммита), а `ask`/`deny` из
    // settings.json — решают.
    const everyRule = new Set<string>(GROUP_REQUEST_IDS);
    const allowed = shouldAutoApprove({
      ...request,
      allowEdits: group.allowEdits,
      allowedRules: everyRule,
    });
    return allowed ? level : 'human';
  }
  const rule: GroupRequestId | undefined = named;
  const level: GroupPermissionLevel = read ? 'auto' : rows[rule ?? 'routine'];
  if (level === 'human') return 'human';
  const allowedRules = new Set<string>(
    GROUP_REQUEST_IDS.filter((id) => id !== 'routine' && rows[id] !== 'human'),
  );
  const allowed = shouldAutoApprove({ ...request, allowEdits: group.allowEdits, allowedRules });
  return allowed ? level : 'human';
}

/** Можно ли разрешить запрос группы без человека (`auto` или `notify`). */
export function groupAllows(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown; guardedPatterns: string[] },
): boolean {
  return groupDecision(group, request) !== 'human';
}

/**
 * Повтор одного и того же вопроса группой под «Развилки: по плану» (F-128):
 * ответ панели мгновенный, и агент, не принявший его, спрашивал снова и снова —
 * петля без человека и без конца. Сколько раз панель отвечает на тот же вопрос
 * той же группы просто; дальше ответ тот же, но с порядком «больше не спрашивай:
 * продолжай с ним или кончай ход с причиной», и отметка в хаб уже не пишется.
 * Голый отказ без ответа лента сочла бы вопросом человеку — ложный пуш «ждёт вас».
 */
export const GROUP_REASK_MAX = 3;

export const GROUP_REASK_LINE =
  'You have already asked this same question several times and got this same answer each ' +
  'time: asking it again is a loop. Do not ask it again — continue with the answer above; if ' +
  'you truly cannot continue with it, end the turn and name the blocker in one line.';

/**
 * Счётчик повторов — в памяти панели, с потолком по числу групп и вопросов
 * (модуль прав без состояния, это единственное исключение). Перезапуск панели
 * обнуляет счёт: худшее — ещё `GROUP_REASK_MAX` ответов той же петле.
 */
const REASK_GROUPS_MAX = 256;
const REASK_QUESTIONS_MAX = 64;
const reasked = new Map<string, Map<string, number>>();

function questionKey(questions: readonly string[]): string {
  return questions
    .map((text) => text.replace(/\s+/g, ' ').trim().toLowerCase())
    .join('\n')
    .slice(0, 500);
}

/**
 * Отметить вопрос группы; возвращает, который это раз (1 — первый). Счёт — на
 * разговор (`runId`): новый разговор группы после паузы спрашивает с чистого листа.
 */
export function noteGroupQuestion(
  group: { parentChatId: string; groupIndex: number },
  runId: string,
  questions: readonly string[],
): number {
  const groupKey = `${group.parentChatId}#${group.groupIndex}#${runId}`;
  const counts = reasked.get(groupKey) ?? new Map<string, number>();
  // Свежая группа — в конец порядка: вытесняется давно молчавшая.
  reasked.delete(groupKey);
  reasked.set(groupKey, counts);
  if (reasked.size > REASK_GROUPS_MAX) reasked.delete(reasked.keys().next().value as string);
  const key = questionKey(questions);
  const count = (counts.get(key) ?? 0) + 1;
  counts.delete(key);
  counts.set(key, count);
  if (counts.size > REASK_QUESTIONS_MAX) counts.delete(counts.keys().next().value as string);
  return count;
}

/** Забыть весь счёт повторов — тестам: состояние модуля общее на процесс. */
export function forgetGroupQuestions(): void {
  reasked.clear();
}

/** Сколько отметок «разрешено автоматически» держит группа — хаб не лента. */
const AUTO_NOTICES_MAX = 20;

export interface GroupNoticeStore {
  getSplitPlan(parentChatId: string): SplitPlanRecord | undefined;
  setSplitPlan(plan: SplitPlanRecord): void;
}

/** Коротко, что прошло без человека: команда или имя инструмента с путём. */
export function autoNoticeSummary(toolName: string, input: unknown): string {
  const command = commandOf(input);
  const path = (input as { file_path?: unknown } | null)?.file_path;
  const text = command ?? (typeof path === 'string' ? `${toolName} ${path}` : toolName);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * Отметка `notify` в записи разделения: хаб родителя покажет её строкой
 * «разрешено автоматически», пока человек её не уберёт. В записи, а не в
 * событии потока: хаб открывают позже, чем прошёл запрос.
 */
export function recordGroupAutoNotice(
  store: GroupNoticeStore,
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): void {
  const plan = store.getSplitPlan(group.parentChatId);
  const target = plan?.groups.find((entry) => entry.index === group.groupIndex);
  if (!plan || !target) return;
  const notice: SplitAutoNotice = {
    at: new Date().toISOString(),
    summary: autoNoticeSummary(request.toolName, request.input),
  };
  // Окно — только у отметок разрешений (F-46): общий срез в 20 выкидывал и
  // автоответы, и разрешения вперемешку; ответам своё окно держит их запись.
  const merged = [...(target.autoNotices ?? []), notice];
  const kept = new Set(merged.filter((entry) => entry.kind !== 'answer').slice(-AUTO_NOTICES_MAX));
  target.autoNotices = merged.filter((entry) => entry.kind === 'answer' || kept.has(entry));
  store.setSplitPlan(plan);
}

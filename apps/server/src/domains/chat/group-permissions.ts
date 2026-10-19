import {
  GROUP_REQUEST_IDS,
  resolveGroupPermissions,
  type GroupPermissionLevel,
  type GroupRequestId,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import type { StoredSplitSettings } from '@agentdeck/contracts/task-split';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { git } from '../project-git/exec/exec.ts';
import { isReadOnlyTool, ruleFor, shouldAutoApprove } from './auto-approve/auto-approve.ts';
import {
  groupCommandVerdict,
  isProtectedBranch,
  type GroupCommandVerdict,
} from './group-command/group-command.ts';

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
  /** Копия группы — каталог прогона (`withWorktree`). */
  worktree?: string;
  /**
   * Своя ветка группы — та, на которой копия стоит по git (`withWorktree`), если
   * она не основная. Из текста команды не берётся никогда: группа могла завести
   * ветку по правилу проекта, а не ту, что в записи разделения.
   */
  ownBranch?: string;
  /** Ветка по умолчанию у `origin` — защищена, как `main` (`withWorktree`). */
  base?: string;
  /** MR группы из записи разделения: у ветки на ревью исключения нет (L7.12). */
  mr?: string;
  /**
   * MR группы открыт и снят с черновика — по форджу, прочитан маршрутом прав
   * перед решением (`needsMrState`). `undefined` — не читали или прочитать не
   * удалось: при известном MR это «на ревью» (решает человек).
   */
  mrInReview?: boolean;
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

/** Нужна ли команде своя ветка копии: пуш — да (слияние — человеку при любой ветке). */
function needsBranch(command: string): boolean {
  return /\bgit\b[\s\S]*\bpush\b/.test(command);
}

/**
 * Копия и своя ветка группы — у git копии, а не из команды (просьба владельца
 * 19.10). Git читается только когда в команде пуш: на каждое разрешение
 * процесс не нужен. Ветка основная или защищённая (`main`, `master`,
 * `develop`, `release/…`, ветка по умолчанию у `origin`), отсоединённая HEAD
 * или git не ответил — своей ветки нет, и пуш без явной цели уходит человеку.
 */
export async function withWorktree(
  group: GroupAutoApprove,
  cwd: string | undefined,
  request: { toolName: string; input: unknown },
): Promise<GroupAutoApprove> {
  if (!cwd) return group;
  const placed = { ...group, worktree: cwd };
  const command = request.toolName === 'Bash' ? commandOf(request.input) : undefined;
  if (!command || !needsBranch(command)) return placed;
  const read = async (args: string[]): Promise<string> =>
    (await git(cwd, args, 5_000).catch(() => '')).trim();
  const [branch, remoteHead] = await Promise.all([
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  const base = remoteHead.replace(/^origin\//, '');
  const known = base ? { ...placed, base } : placed;
  if (!branch || isProtectedBranch(branch, base)) return known;
  return { ...known, ownBranch: branch };
}

function verdictOf(
  group: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): GroupCommandVerdict | undefined {
  const command = request.toolName === 'Bash' ? commandOf(request.input) : undefined;
  if (command === undefined) return undefined;
  return groupCommandVerdict(command, {
    ...(group.worktree ? { worktree: group.worktree } : {}),
    ...(group.ownBranch ? { branch: group.ownBranch } : {}),
    ...(group.base ? { base: group.base } : {}),
  });
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
  return verdict?.kind === 'routine' && verdict.lease;
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
  const rows = group.rows;
  // Команда оболочки разобрана по звеньям (`group-command.ts`): опасное —
  // человеку при любых строках, рутина своей копии — строкой пуша/коммита или
  // «обычной работы», прочее — правилами чата ниже.
  const verdict = verdictOf(group, request);
  if (verdict?.kind === 'danger') return 'human';
  if (verdict?.kind === 'routine') {
    // Аренда своей ветки, чей MR на ревью (L7.12), затирает то, что читают ревьюеры.
    if (verdict.lease && branchUnderReview(group)) return 'human';
    // Уборка временного — строкой «удаление файлов», пуш и коммит — «записью в git».
    const level = verdict.writes
      ? rows.gitWrite
      : verdict.deletes
        ? rows.filesDelete
        : rows.routine;
    if (level === 'human') return 'human';
    // Правило чата здесь не решает (оно видело `--force` в `--force-with-lease`
    // и «drop» в сообщении коммита), а `ask`/`deny` из settings.json — решают.
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
  const notice = {
    at: new Date().toISOString(),
    summary: autoNoticeSummary(request.toolName, request.input),
  };
  target.autoNotices = [...(target.autoNotices ?? []), notice].slice(-AUTO_NOTICES_MAX);
  store.setSplitPlan(plan);
}

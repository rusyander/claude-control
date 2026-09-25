import {
  GROUP_REQUEST_IDS,
  resolveGroupPermissions,
  type GroupPermissionLevel,
  type GroupRequestId,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import type { StoredSplitSettings } from '@agentdeck/contracts/task-split';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { isReadOnlyTool, ruleFor, shouldAutoApprove } from './auto-approve.ts';

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
        groups: { index: number; branch: string }[];
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
  /** Ветка группы — исключение для пуша арендой своей ветки. */
  branch?: string;
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
      parentChatId: link.parentChatId,
      groupIndex: group.index,
    };
  }
  return undefined;
}

/**
 * Пуш арендой СВОЕЙ ветки группы после rebase (решение владельца, W3-3): одна
 * команда целиком, без звеньев `&&`/`;`/`|`, в `origin` и ровно в ветку группы.
 * Строка «затирание истории» у человека (аудит 25.09, L163), но без этого пуша
 * группа, догнавшая основную ветку, встала бы на карточке у самого MR, а чужую
 * ветку так не затереть: имя сверяется с веткой из записи разделения.
 */
function isOwnBranchLeasePush(command: string | undefined, branch: string | undefined): boolean {
  if (!command || !branch) return false;
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\s*git\\s+push\\s+--force-with-lease\\s+origin\\s+(?:HEAD:)?${escaped}\\s*$`,
  ).test(command);
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
  request: { toolName: string; input: unknown; guardedPatterns: string[] },
): GroupPermissionLevel {
  const read = isReadOnlyTool(request.toolName);
  const named = ruleFor(request.toolName, request.input);
  // Правка основной копии — не строка группы: группа пишет только в своей.
  if (named === 'editInMainCopy') return 'human';
  let rule: GroupRequestId | undefined = named;
  const rows = { ...group.rows };
  if (
    rule === 'gitHistory' &&
    rows.gitWrite !== 'human' &&
    isOwnBranchLeasePush(commandOf(request.input), group.branch)
  ) {
    // Решает строка пуша, а не затирания: это обычная доставка своей ветки.
    rows.gitHistory = rows.gitWrite;
    rule = 'gitWrite';
  }
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

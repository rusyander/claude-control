import { basename } from 'node:path';
import type {
  DeferredAskKind,
  DeferredAskSource,
  DeferredReasonCode,
  DeferredReasonParams,
  DeferredScope,
} from '@agentdeck/contracts/deferred-asks';
import type { PermissionGuardReason } from '@agentdeck/contracts';
import {
  alreadyQueuedDenial,
  deferralDenial,
  humanRefusedDenial,
  mergeRefusal,
  unresolvedPushRefusal,
  type DeferredAsks,
} from '../../../domains/chat/deferred-asks/deferred-asks.ts';
import { groupAutoApproveFor } from '../../../domains/chat/group-permissions.ts';
import { git } from '../../../domains/project-git/exec/exec.ts';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { BRAND_SLUG, LEGACY_BRAND_SLUG } from '../../../lib/brand.mjs';
import { PUSH_UNRESOLVED_CAUSE, pushVerdictOf, type BranchFacts } from './push-targets.ts';

export type { BranchFacts } from './push-targets.ts';
export { deliveryRefusal } from './deferred-delivery.ts';

/**
 * Выходы моста прав в отложенный вопрос D-n (решения владельца 23.10) — то,
 * что `run-routes.ts` зовёт по пути запроса прав. Здесь только суждения о
 * вызове и заведение записи; порядок проверок — в самом мосте.
 */

const text = (input: unknown, field: string): string => {
  const value = (input as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : '';
};

/** Всё строковое во входе вызова одной строкой — для поиска адресов и номеров. */
function flatText(input: unknown, depth = 0): string {
  if (typeof input === 'string') return input;
  if (depth > 4 || input === null || typeof input !== 'object') return '';
  return Object.values(input as Record<string, unknown>)
    .map((value) => flatText(value, depth + 1))
    .join('\n');
}

/**
 * Маршруты, которыми человек отвечает панели, и ключ её удалённого доступа.
 * Вызов, который до них тянется, — попытка ответить за человека.
 */
const DECISION_ROUTE =
  /\/api\/(?:chat\/[^\s'"`]*\/(?:permission-decision|branch-decision|auto-approve|auto-mode)|chat\/deferred(?:\/|\b)|outside\/asks\/[^\s'"`]*\/answer|chat\/split\/[^\s'"`]*\/review-decision)/i;
const TOKEN_FILE = /\.agentdeck[\\/]+(?:api-token|\*|\?)/i;
/**
 * Путь можно разорвать: `cd ~/.agentdeck && cat api-token`, `--directory
 * ~/.agentdeck api-token`. Папка и имя ключа в ОДНОМ вызове — уже попытка.
 */
const TOKEN_PARTS = [/\.agentdeck\b/i, /\bapi-token\b/i];
/**
 * Файлы, которыми D-n решается НАПРЯМУЮ, без маршрута: хранилище отложенных
 * вопросов (`domains/chat/deferred-asks/store.ts`, `DEFERRED_ASKS_FILE`) и
 * ответы из Telegram (`domains/notify/telegram-answers/store.ts`,
 * `ANSWERS_FILE`) — запись в них равна нажатию кнопки человека. Снимок настроек
 * (`lib/app-store/settings-snapshot.ts`) панель применяет при старте поверх
 * своих: рычагов решений он с 24.10 не несёт (`settings-snapshot-levers.ts`), но
 * группы, автоматизации и проекты — несёт, и запись в него с перезапуском панели
 * — тот же импорт настроек, что закрыт воротами (RF-DS-07).
 */
const DECISION_STORE =
  /\b(?:deferred-asks|telegram-answers)\.json\b|\bsettings-snapshot\.(?:json|seen)\b/i;
/**
 * Каталог данных панели отрезком пути: `<конфигурация>/agentdeck`, `~/.agentdeck`,
 * прежнее имя под `.claude*`. Пакет `@agentdeck/…` и `agentdeck-kit` — не он.
 * Вместе с `state.json` в одном вызове — правка рычагов решения (`chatAutoMode`).
 */
const PANEL_DIR = new RegExp(
  `(?:^|[\\s'"\`=/~])\\.?${BRAND_SLUG}(?=[\\s'"\`/;&|)]|$)|\\.claude[^\\s'"\`/]*/${LEGACY_BRAND_SLUG}(?=[\\s'"\`/;&|)]|$)`,
  'i',
);
const PANEL_STATE = /\bstate\.json\b/i;
/**
 * Инструменты правки файла: всё, кроме пути, у них — текст будущего файла.
 * Исходники панели называют хранилища и ключ доступа в коде и комментариях, и
 * правка такого исходника отбивалась как «ответ за человека» — судится путь.
 */
const EDITING = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/i;
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;
/**
 * Инструменты, которые только ищут и читают: назвать хранилище им можно —
 * решить им нечего (номера своих D-n агент и так знает из текста отказа).
 */
const READ_ONLY = /^(?:Read|Grep|Glob|Search|LS|NotebookRead)$/i;
/** Признак сетевого вызова: имя маршрута в `grep` по исходникам панели — не вызов. */
const NETWORK =
  /\b(?:curl|wget|http|https|fetch|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|axios|request|undici|nc|ncat|telnet|socat|websocat|python|node|deno|bun|powershell|pwsh)\b|127\.0\.0\.1|localhost|\[::1\]/i;
/** Инструменты, у которых вход — команда или адрес, а не текст файла. */
const EXECUTING = /^(?:Bash|PowerShell|WebFetch)$|^mcp__.*(?:fetch|navigate|request|http|browser)/i;

/**
 * Вызов тянется к решению человека (решение 3): маршруты решений через сеть
 * или ключ доступа панели. Правка исходников панели, где эти маршруты названы,
 * — не вызов: судятся только исполняющие инструменты, и адрес — вместе с
 * признаком сетевого клиента. Ключ доступа читать агенту незачем вовсе.
 */
export function reachesPanelDecision(toolName: string, input: unknown): boolean {
  const all = EDITING.test(toolName)
    ? PATH_FIELDS.map((field) => text(input, field)).join('\n')
    : flatText(input);
  // Разделители пути нормализуются: `~/.agentdeck\api-token`, двойной слэш,
  // «папка отдельно, имя отдельно» — одна и та же попытка (D-S01).
  const normalized = all.replace(/[\\/]+/g, '/');
  if (TOKEN_FILE.test(normalized)) return true;
  if (TOKEN_PARTS.every((part) => part.test(normalized))) return true;
  // Хранилище решений и рычаги решения — файлы: писать в них может только панель.
  const store =
    DECISION_STORE.test(normalized) || (PANEL_DIR.test(normalized) && PANEL_STATE.test(normalized));
  if (store && !READ_ONLY.test(toolName)) return true;
  if (!EXECUTING.test(toolName)) return false;
  return (
    DECISION_ROUTE.test(normalized) &&
    (toolName !== 'Bash' && toolName !== 'PowerShell' ? true : NETWORK.test(normalized))
  );
}

const MR_MERGE_TOOL =
  /(?:^|__)(?:merge_merge_request|accept_merge_request|merge_pull_request|merge_pr|mr_merge)$/i;
/** Слияние MR через API форджа: `…/merge_requests/5/merge`, `…/pulls/5/merge`. */
const API_MERGE = /\/(?:merge_requests|pulls)\/\d+\/merge\b/;
/** Push-опция GitLab «слить, когда пройдёт конвейер» — то же слияние руками агента. */
const MERGE_PUSH_OPTION = /^merge_request\.(?:merge_when_pipeline_succeeds|auto_merge)\b/;
/** Push-опция «слить» в любом написании: `-o x`, `--push-option=x`. */
const MERGE_PUSH_WORD = new RegExp(
  `(?:^|\\s)(?:-o|--push-option)[=\\s]+["']?${MERGE_PUSH_OPTION.source.slice(1)}`,
);

/**
 * Слияние MR или push в main и защищённую ветку — шаг владельца (решение 2):
 * ответ известен («сливает владелец; запушь свою ветку и сдай MR»), вопроса
 * человеку нет. Сюда же — локальный `git merge` В защищённую ветку (копия на
 * ней или переключена на неё той же командой): итог тот же — слияние в main.
 * `git merge` в свою рабочую ветку — работа группы, её решает человек как D-n.
 *
 * Цель пуша судит `push-targets.ts` настоящим разбором оболочки: формы
 * `HEAD:"main"`, `HEAD:$B`, `--all`, `--mirror`, алиас и шаблон раньше проходили
 * мимо и становились разрешаемой одной кнопкой D-n (холодное ревью 23.10,
 * D-S02). Недоказуемая цель — тоже отказ: умолчание default-deny.
 */
export function protectedWriteRefusal(
  toolName: string,
  input: unknown,
  facts: BranchFacts = {},
): string | undefined {
  if (MR_MERGE_TOOL.test(toolName)) return mergeRefusal();
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return undefined;
  const command = text(input, 'command');
  if (/\b(?:glab\s+mr|gh\s+pr)\s+merge\b/.test(command)) return mergeRefusal();
  if (API_MERGE.test(command) && (NETWORK.test(command) || /\b(?:gh|glab)\s+api\b/.test(command))) {
    return mergeRefusal();
  }
  if (MERGE_PUSH_WORD.test(command)) return mergeRefusal();
  // Чужая оболочка (PowerShell) разбору POSIX не поддаётся — там грубые слова.
  const verdict = pushVerdictOf(command, facts, toolName !== 'PowerShell');
  if (verdict?.kind === 'protected') return mergeRefusal();
  if (verdict?.kind === 'unresolved')
    return unresolvedPushRefusal(PUSH_UNRESOLVED_CAUSE[verdict.why]);
  return undefined;
}

/** То же суждение одним признаком — для правил и проверок, читающих «да/нет». */
export function mergesOrPushesMain(
  toolName: string,
  input: unknown,
  facts: BranchFacts = {},
): boolean {
  return protectedWriteRefusal(toolName, input, facts) !== undefined;
}

/**
 * Ветка копии по git — только для команды с `git push`/`git merge` без явной
 * цели: «`git push` с копии на main» иначе ушёл бы человеку вопросом, хотя
 * ответ на него известен. Не прочиталось — фактов нет, судит текст команды.
 */
export async function branchFactsOf(
  cwd: string | undefined,
  toolName: string,
  input: unknown,
  base?: string,
): Promise<BranchFacts> {
  const command = toolName === 'Bash' || toolName === 'PowerShell' ? text(input, 'command') : '';
  if (!cwd || !/\bgit\b[^\n]*\b(?:push|merge)\b/.test(command)) return base ? { base } : {};
  const branch = (
    await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5_000).catch(() => '')
  ).trim();
  return { ...(branch ? { branch } : {}), ...(base ? { base } : {}) };
}

/** Чьё это: группа разделения (по записи плана) или ключи одиночного чата. */
export function scopeOfRun(store: AppStore, keys: readonly (string | undefined)[]): DeferredScope {
  const group = groupAutoApproveFor(store, keys);
  if (group?.parentChatId && typeof group.groupIndex === 'number') {
    return { kind: 'group', parentChatId: group.parentChatId, groupIndex: group.groupIndex };
  }
  return {
    kind: 'chat',
    chatKeys: [...new Set(keys.filter((key): key is string => Boolean(key)))],
  };
}

/**
 * Ворота ветки как D-n — вопрос «где писать», а не про вызов: одна запись на
 * чат и каталог, сколько бы разных правок ни упёрлось в ворота. Поэтому
 * отпечаток берётся с этой условной пары, а не с правки.
 */
export const MAIN_COPY_TOOL = 'agentdeck:main-copy';
export const mainCopyInput = (cwd: string): { path: string } => ({ path: cwd });

/**
 * Причина D-n: `text` уходит агенту в отказе (по-английски), код — человеку,
 * который читает её на языке панели (живой прогон 23.10: английская строка
 * стояла в русской плашке).
 */
export interface DeferReason {
  text: string;
  code: DeferredReasonCode;
  params?: DeferredReasonParams;
}

/** Причина D-n ворот ветки: где писать, решает человек. */
export const MAIN_COPY_REASON: DeferReason = {
  text: 'a write in the main copy of the project: the human decides where this work writes',
  code: 'main-copy',
};

/** Своя копия группы по записи плана; нет — группа идёт в основной копии. */
export function groupCopyOf(store: AppStore, scope: DeferredScope): string | undefined {
  if (scope.kind !== 'group') return undefined;
  const plan = store.getSplitPlan(scope.parentChatId);
  return plan?.groups.find((entry) => entry.index === scope.groupIndex)?.path || undefined;
}

/** Подпись записи для человека: проект, чат, группа. */
export function sourceOfRun(
  store: AppStore,
  scope: DeferredScope,
  cwd: string,
  chatTitle?: string,
): DeferredAskSource {
  if (scope.kind === 'group') {
    const plan = store.getSplitPlan(scope.parentChatId);
    const group = plan?.groups.find((entry) => entry.index === scope.groupIndex);
    const projectPath = plan?.projectPath ?? cwd;
    return {
      project: basename(projectPath),
      projectPath,
      group: scope.groupIndex + 1,
      ...(group?.title ? { groupTitle: group.title } : {}),
      ...(chatTitle ? { chatTitle } : {}),
    };
  }
  return { project: basename(cwd), projectPath: cwd, ...(chatTitle ? { chatTitle } : {}) };
}

/** Почему это решает человек — в тексте отказа агенту и в списке. */
export function deferReason(
  guard: PermissionGuardReason | undefined,
  grouped: boolean,
): DeferReason {
  if (guard) {
    return {
      text: `backend guard ${guard.rule}: ${guard.match}`,
      code: 'backend-guard',
      params: { rule: guard.rule, match: guard.match },
    };
  }
  return grouped
    ? { text: "the group's permission rows send this call to the human", code: 'group-rows' }
    : { text: 'it is not covered by the auto-approve rules', code: 'not-auto-approved' };
}

export interface DeferCall {
  scope: DeferredScope;
  runKeys: string[];
  toolName: string;
  input: unknown;
  toolUseId?: string;
  reason: string;
  reasonCode?: DeferredReasonCode;
  reasonParams?: DeferredReasonParams;
  kind?: DeferredAskKind;
  cwd?: string;
  source?: DeferredAskSource;
}

/** Завести (или узнать) запись и отдать текст отказа агенту. */
export function deferCall(asks: DeferredAsks, call: DeferCall): { id: string; message: string } {
  const outcome = asks.ask(call);
  const { id } = outcome.record;
  if (outcome.kind === 'created') return { id, message: deferralDenial(id, call.reason) };
  if (outcome.kind === 'queued') return { id, message: alreadyQueuedDenial(id) };
  return { id, message: humanRefusedDenial(id, outcome.record.message) };
}

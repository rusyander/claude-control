import type { DeferredScope } from '@agentdeck/contracts/deferred-asks';
import { deferredIdsIn } from '@agentdeck/contracts/deferred-asks';
import {
  keepDraftRefusal,
  mrMentionRefusal,
  sameScope,
  type DeferredAsks,
} from '../../../domains/chat/deferred-asks/deferred-asks.ts';

/**
 * Доставка, пока группа ждёт человека (решение 6 владельца 23.10): черновик MR
 * не снимается, номер D-n в коммите и MR не место. Вынесено из
 * `deferred-bridge.ts` (тот реэкспортирует `deliveryRefusal`), когда к формам
 * снятия черновика добавились push-опции, заголовок CLI и API форджа (RF-DL-09).
 */

const text = (input: unknown, field: string): string => {
  const value = (input as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : '';
};

const MR_TOOL = /(?:^|__)(?:create|update)_(?:merge_request|pull_request|mr|pr)$/i;
/** Инструменты, которые прямо переводят MR из черновика в готовый. */
const MR_READY_TOOL =
  /(?:^|__)(?:mark_(?:merge_request|pull_request|mr|pr)_(?:as_)?ready(?:_for_review)?|ready_for_review)$/i;
const DRAFT_TITLE = /^\s*(?:\[?draft\]?:?|\(draft\)|wip:?)\s*/i;
/**
 * Push-опции GitLab, которые заводят или правят MR (`merge_request.create`
 * заводит его НЕ черновиком) и конвейер (`ci.skip`) — в этом же `git push`
 * (RF-DL-09, повторное ревью 24.10).
 */
const MR_PUSH_OPTION =
  /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(?:-o\s*|--push-option[=\s]+)["']?(?:merge_request|ci)\./i;
/** Те же опции настройкой: `-c push.pushOption=…`, `GIT_CONFIG_KEY_n`, `git config`. */
const MR_PUSH_CONFIG = /\bpush\.pushoption\b[^\n]*\b(?:merge_request|ci)\./i;
/** Заголовок в `glab mr update --title|-t`: без «Draft:» GitLab снимает черновик. */
const GLAB_TITLE = /(?:^|\s)(?:--title|-t)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** REST GitLab: правка MR методом PUT; GraphQL GitHub: «готов к ревью». */
const API_MR = /merge_requests\/\d+(?=["'\s?]|$)/i;
const API_PUT = /(?:-X\s*|--method[=\s]+|--request[=\s]+)["']?PUT\b/i;
const API_UNDRAFT_FIELD = /\b(?:draft|wip|work_in_progress)=false\b/i;
const API_TITLE_FIELD = /\btitle=(?:"([^"]*)"|'([^']*)'|([^\s&]*))/i;

/** Правка MR через API форджа, после которой он не черновик. */
function apiUndrafts(command: string): boolean {
  if (/\bmarkPullRequestReadyForReview\b/.test(command)) return true;
  if (!API_MR.test(command) || !API_PUT.test(command)) return false;
  if (API_UNDRAFT_FIELD.test(command)) return true;
  const title = API_TITLE_FIELD.exec(command);
  return Boolean(title) && !DRAFT_TITLE.test(title?.[1] ?? title?.[2] ?? title?.[3] ?? '');
}

function mrCommand(command: string): 'glab' | 'gh' | undefined {
  if (/\bglab\s+mr\s+(?:create|update|new)\b/.test(command)) return 'glab';
  if (/\bgh\s+pr\s+(?:create|edit|ready)\b/.test(command)) return 'gh';
  return undefined;
}

/** Снимает ли вызов черновик (или заводит MR сразу не черновиком). */
function undrafts(toolName: string, input: unknown): boolean {
  if (MR_TOOL.test(toolName)) {
    const record = (input ?? {}) as Record<string, unknown>;
    if (record.draft === false || record.work_in_progress === false) return true;
    const title = typeof record.title === 'string' ? record.title : undefined;
    const creating = /create_/i.test(toolName);
    if (title !== undefined && !DRAFT_TITLE.test(title) && record.draft !== true) return true;
    return creating && title === undefined && record.draft !== true;
  }
  if (MR_READY_TOOL.test(toolName)) return true;
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return false;
  const command = text(input, 'command');
  if (MR_PUSH_OPTION.test(command) || MR_PUSH_CONFIG.test(command)) return true;
  const cli = mrCommand(command);
  if (cli === 'gh') {
    if (/\bgh\s+pr\s+ready\b/.test(command) && !/--undo\b/.test(command)) return true;
    return /\bgh\s+pr\s+create\b/.test(command) && !/(?:^|\s)(?:--draft|-d)\b/.test(command);
  }
  if (cli === 'glab') {
    if (/--ready\b|--draft=false\b|--wip=false\b/.test(command)) return true;
    const drafted = /--(?:draft|wip)\b/.test(command);
    if (/\bglab\s+mr\s+(?:create|new)\b/.test(command)) return !drafted;
    // Как в ветке MCP выше: заголовок без «Draft:» снимает черновик.
    const title = GLAB_TITLE.exec(command);
    if (title && !drafted && !DRAFT_TITLE.test(title[1] ?? title[2] ?? title[3] ?? '')) return true;
  }
  return apiUndrafts(command);
}

/** Текст коммита и MR, где номер D-n не место (решение 6). */
function publishedText(toolName: string, input: unknown): string | undefined {
  if (MR_TOOL.test(toolName)) {
    return [text(input, 'title'), text(input, 'description'), text(input, 'body')].join('\n');
  }
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return undefined;
  const command = text(input, 'command');
  if (mrCommand(command) || /\bgit\s+(?:[^\n]*\s)?commit\b/.test(command)) return command;
  return undefined;
}

/**
 * Черновик MR и текст публикации, пока группа ждёт человека: снять черновик
 * можно, только когда ни одна запись группы не ждёт; номер D-n в коммите и MR
 * не место. Отказ с известным ответом — не вопрос человеку.
 */
export function deliveryRefusal(
  asks: DeferredAsks,
  scope: DeferredScope,
  toolName: string,
  input: unknown,
): string | undefined {
  const published = publishedText(toolName, input);
  if (published) {
    const known = new Set(
      asks
        .all()
        .filter((record) => sameScope(record.scope, scope))
        .map((record) => record.id),
    );
    const named = deferredIdsIn(published).filter((id) => known.has(id));
    if (named.length > 0) return mrMentionRefusal(named);
  }
  if (scope.kind !== 'group') return undefined;
  const waiting = asks.waiting(scope).map((record) => record.id);
  if (waiting.length > 0 && undrafts(toolName, input)) return keepDraftRefusal(waiting);
  return undefined;
}

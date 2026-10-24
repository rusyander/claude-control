import {
  DEFERRED_MARKER,
  PANEL_REFUSAL_MARKER,
  type DeferredVia,
} from '@agentdeck/contracts/deferred-asks';
import { canonicalJson, significantInput } from './hash.ts';

/**
 * Тексты отказов и продолжений D-n. По-английски: их читает модель (решение
 * D-E, `server-model-english.test.ts`). Каждый отказ начинается меткой —
 * по ней лента, реестр и исход хода узнают, что человека НЕ ждут сейчас.
 */

const NO_MR_MENTION =
  'Do not mention this item in commits, the MR title or the MR description: published text ' +
  'describes the change only.';

/**
 * Черновик снимает АГЕНТ: панель его не трогает, а продолжения об этом не
 * говорили — MR мог остаться черновиком навсегда (D-L12, решение владельца
 * 23.10). Пока хоть одна запись ждёт, снять черновик мост всё равно не даст.
 */
const UNDRAFT_WHEN_CLEAR =
  'When no item of this work waits for the human any more, take the MR out of draft and finish ' +
  'the delivery.';

/** Первый отказ: вызов поставлен человеку. */
export function deferralDenial(id: string, reason: string): string {
  return (
    `${DEFERRED_MARKER}${id}) This call needs the human's decision (${reason}). It is queued for ` +
    `the human as ${id}. Do not retry it and do not work around it (no other command that does ` +
    'the same thing). Continue everything that does not depend on it. When nothing else remains, ' +
    `end the turn with one line per open item: "Waiting for the human: ${id} — <what it unblocks>". ` +
    'If the human allows it, the panel resumes this work with a one-time grant for exactly this ' +
    `call. Keep the MR a draft while an item waits. ${NO_MR_MENTION}`
  );
}

/** Тот же вызов, пока запись ждёт. */
export function alreadyQueuedDenial(id: string): string {
  return (
    `${DEFERRED_MARKER}${id}) This exact call is already queued for the human as ${id}. Do not ` +
    'retry it — every retry gets this same answer. Continue the work that does not depend on it, ' +
    `then end the turn with "Waiting for the human: ${id} — <what it unblocks>".`
  );
}

/** Тот же вызов после отказа человека. */
export function humanRefusedDenial(id: string, message?: string): string {
  const said = message?.trim() ? `: ${message.trim()}` : '';
  return (
    `${DEFERRED_MARKER}${id}) The human refused ${id}${said}. Do not retry it and do not work ` +
    'around it; finish the task without it, or end the turn naming what stays blocked.'
  );
}

/** Отказ с известным ответом: слияние и push в main решает владелец, не вопрос. */
export function mergeRefusal(): string {
  return (
    `${PANEL_REFUSAL_MARKER} Merging and pushing to the main or protected branch is the owner's ` +
    'step, not yours, and it is not queued: the owner merges. Push your own branch and deliver ' +
    'the MR; continue the rest of the work.'
  );
}

/**
 * Пуш, чью цель доказать нельзя (кавычки, переменная, `--all`, алиас, шаблон):
 * цель могла быть main, поэтому ответ тот же, что у слияния, — отказ, а не
 * вопрос человеку (холодное ревью 23.10, D-S02). Агенту говорится, ЧТО сделать:
 * назвать ветку явно одним refspec.
 */
export function unresolvedPushRefusal(cause: string): string {
  return (
    `${PANEL_REFUSAL_MARKER} The panel cannot prove where this push writes (${cause}), and a push ` +
    "to the main or protected branch is the owner's step, not yours. Name the branch in one plain " +
    'refspec — `git push origin <your-branch>` — and repeat the call; the owner merges.'
  );
}

/** Группа пишет в основную копию: ответ известен — её копия своя. */
export function groupMainCopyRefusal(worktree: string): string {
  return (
    `${PANEL_REFUSAL_MARKER} The main copy of the project is not yours: write in your copy ` +
    `${worktree}. For a scratch file use ${worktree}/.agent/tmp. Repeat the edit there and continue.`
  );
}

/** Снятие черновика, пока ждёт D-n. */
export function keepDraftRefusal(ids: readonly string[]): string {
  return (
    `${PANEL_REFUSAL_MARKER} Keep the MR a draft: ${ids.join(', ')} still waits for the human. ` +
    'The draft comes off only when no item waits; continue the rest of the work.'
  );
}

/** Текст MR называет D-n. */
export function mrMentionRefusal(ids: readonly string[]): string {
  return (
    `${PANEL_REFUSAL_MARKER} Remove ${ids.join(', ')} from the MR text and repeat the call: ` +
    'published text describes the change only, panel items stay out of it.'
  );
}

/**
 * Вызов тянется к решению человека в обход него: маршруты решений панели или
 * её ключ доступа. Не откладывается — решать тут нечего.
 */
export function selfApprovalRefusal(): string {
  return (
    `${PANEL_REFUSAL_MARKER} This call reaches the panel's decision endpoints or its access ` +
    'token. Only the human answers permission requests and queued items; an agent never ' +
    'answers them, not even its own. Do not retry it in any form; continue the rest of the work.'
  );
}

/** Точный вызов знак в знак: вход целиком и, у `Bash`, сама команда отдельно. */
function exactCall(record: { toolName: string; input: unknown }): string {
  const exact = canonicalJson(significantInput(record.toolName, record.input));
  const command =
    record.toolName === 'Bash' &&
    typeof (record.input as { command?: unknown })?.command === 'string'
      ? `\n\nThe command, character for character:\n${String((record.input as { command: string }).command)}`
      : '';
  return `${exact}${command}`;
}

/**
 * Продолжение после «разрешить»: точный вызов знак в знак — новый разговор
 * группы его не помнит, а разрешение сверяется по отпечатку всего входа.
 */
export function allowResumePrompt(record: {
  id: string;
  toolName: string;
  input: unknown;
  decidedVia?: DeferredVia;
}): string {
  const who = record.decidedVia === 'auto' ? PANEL_RECHECK : 'The human allowed';
  return (
    `${who} ${record.id}. Make exactly that call now — tool ${record.toolName} with this ` +
    `input, unchanged (a one-time grant; any other call is not covered):\n${exactCall(record)}\n\n` +
    'Then continue the remaining work. Do not mention the item in commits or the MR text. ' +
    UNDRAFT_WHEN_CLEAR
  );
}

/**
 * Запись сняла сама панель (`decidedVia: 'auto'`): правило, по которому вызов
 * ушёл человеку, с тех пор решает его без человека (D-1, 24.10). Слово не
 * приписывает решение человеку, а отказ несёт причину и что делать вместо.
 */
const PANEL_RECHECK = 'The panel re-checked and allowed';

function panelRefused(id: string, said: string): string {
  return (
    `The panel re-checked ${id} and refused it, so nothing waits for the human on it${said} ` +
    'Do not repeat that call as it was.'
  );
}

/** Продолжение после «разрешить» на ворота ветки: писать в основной копии можно. */
export function allowMainCopyPrompt(record: { id: string; input: unknown }): string {
  const path = String((record.input as { path?: unknown } | null)?.path ?? '');
  return (
    `The human allowed ${record.id}: this work may write in the main copy of the project` +
    `${path ? ` (${path})` : ''}. Repeat the write that was refused there, then continue the ` +
    `remaining work. Do not mention the item in commits or the MR text. ${UNDRAFT_WHEN_CLEAR}`
  );
}

/** Продолжение после «запретить», когда группа уже кончила ход ожиданием. */
export function denyResumePrompt(record: {
  id: string;
  message?: string;
  decidedVia?: DeferredVia;
}): string {
  const said = record.message?.trim() ? `: ${record.message.trim()}` : '';
  if (record.decidedVia === 'auto') return `${panelRefused(record.id, said)} ${UNDRAFT_WHEN_CLEAR}`;
  return (
    `The human refused ${record.id}${said}. Do not make that call and do not work around it. ` +
    'Finish the work without it; if something stays blocked, name it as a gap in the MR ' +
    `description in plain words, without the item number. ${UNDRAFT_WHEN_CLEAR}`
  );
}

/**
 * Срок записи вышел, человек не ответил — и ждать больше нечего: группа иначе
 * стояла бы ожиданием записи, которой уже нет (D-L12). Отличается от отказа:
 * человек НЕ сказал «нет», он просто не ответил.
 */
export function expiredResumePrompt(record: { id: string }): string {
  return (
    `${record.id} expired without an answer from the human, and nothing of this work waits for ` +
    'the human any more. Do not make that call and do not work around it. Finish the work ' +
    'without it and name what stays blocked in the MR description in plain words, without the ' +
    `item number. ${UNDRAFT_WHEN_CLEAR}`
  );
}

/**
 * Разрешение истекло НЕИСПОЛЬЗОВАННЫМ: человек сказал «да», но слово до группы
 * не дошло (панель стояла, группа была на паузе), и срок разрешения кончился.
 * Говорить «человек не ответил» тут нельзя — он ответил; поэтому слово своё
 * (живой прогон R8.3): вызов сейчас не делать, нужен — спросить заново.
 */
export function lapsedGrantPrompt(record: { id: string }): string {
  return (
    `The one-time grant for ${record.id} lapsed before this work used it, and nothing of this ` +
    'work waits for the human any more. Do not make that call under the old grant. If the work ' +
    'still needs it, make the call once more — it goes to the human as a fresh item; otherwise ' +
    'finish the work without it and name what stays blocked in the MR description in plain ' +
    `words, without the item number. ${UNDRAFT_WHEN_CLEAR}`
  );
}

/** Исход записи, о котором разговору ещё не сказано (`deferred-wiring.ts`). */
export interface OutcomeItem {
  id: string;
  state: 'allowed' | 'denied' | 'expired';
  kind?: string;
  toolName: string;
  input: unknown;
  message?: string;
  /** `auto` — решила сама панель повторным судом, не человек: слово говорит это. */
  decidedVia?: DeferredVia;
  /** Было разрешение: у истёкшей записи это «разрешение истекло неиспользованным». */
  grantUntil?: string;
}

const isLapsedGrant = (item: OutcomeItem): boolean =>
  item.state === 'expired' && item.grantUntil !== undefined;

function singleOutcome(item: OutcomeItem): string {
  if (item.state === 'allowed') {
    return item.kind === 'branchGate' ? allowMainCopyPrompt(item) : allowResumePrompt(item);
  }
  if (item.state === 'denied') return denyResumePrompt(item);
  return isLapsedGrant(item) ? lapsedGrantPrompt(item) : expiredResumePrompt(item);
}

function outcomeLine(item: OutcomeItem): string {
  if (item.state === 'allowed') {
    if (item.kind === 'branchGate') {
      const path = String((item.input as { path?: unknown } | null)?.path ?? '');
      return (
        `- ${item.id}: the human allowed this work to write in the main copy of the project` +
        `${path ? ` (${path})` : ''}. Repeat the write that was refused there.`
      );
    }
    const who =
      item.decidedVia === 'auto'
        ? 'the panel re-checked it and allowed it'
        : 'the human allowed it';
    return (
      `- ${item.id}: ${who}. Make exactly that call now — tool ${item.toolName} with ` +
      `this input, unchanged (a one-time grant; any other call is not covered):\n${exactCall(item)}`
    );
  }
  if (item.state === 'denied') {
    const said = item.message?.trim() ? `: ${item.message.trim()}` : '';
    if (item.decidedVia === 'auto') return `- ${panelRefused(item.id, said)}`;
    return `- ${item.id}: the human refused it${said}. Do not make that call and do not work around it.`;
  }
  if (isLapsedGrant(item)) {
    return (
      `- ${item.id}: the one-time grant lapsed before this work used it. Do not make that call ` +
      'under the old grant; if the work still needs it, make the call once more — it goes to the ' +
      'human as a fresh item.'
    );
  }
  return `- ${item.id}: expired without an answer from the human. Do not make that call and do not work around it.`;
}

/**
 * Одно слово разговору обо ВСЕХ исходах, о которых ему ещё не сказано. Слово
 * складывается в миг доставки, а не постановки в очередь: исход мог смениться,
 * пока слово ждало конца хода (разрешение использовано, срок вышел), и слово о
 * прежнем исходе велело бы повторить уже сделанный вызов (RF-DL-01). Несколько
 * исходов сразу — одно слово: три истёкшие записи будили группу трижды, и
 * каждое слово уверяло, что ждать больше нечего (RF-DL-03, RF-DL-16).
 *
 * Один исход и больше ничего не ждёт — прежний текст этого исхода, знак в знак.
 */
export function outcomesPrompt(items: readonly OutcomeItem[], waiting: readonly string[]): string {
  const [first] = items;
  if (first && items.length === 1 && (first.state !== 'expired' || waiting.length === 0)) {
    return singleOutcome(first);
  }
  const tail =
    waiting.length > 0
      ? `Still waiting for the human: ${waiting.join(', ')} — keep the MR a draft while they wait.`
      : 'Nothing of this work waits for the human any more: take the MR out of draft and finish ' +
        'the delivery.';
  return (
    `The panel has the human's answers on items of this work:\n${items.map(outcomeLine).join('\n')}\n\n` +
    'Then continue the remaining work. Finish without what was refused or expired and name what ' +
    'stays blocked in the MR description in plain words, without item numbers. Do not mention the ' +
    `items in commits or the MR text. ${tail}`
  );
}

/**
 * Близнец вызова (тот же вызов в том же ответе модели) решён человеком с
 * карточки, пока этот ждал: вызов один, решение одно (RF-DL-02).
 */
export function twinDecidedDenial(behavior: 'allow' | 'deny'): string {
  return behavior === 'allow'
    ? `${PANEL_REFUSAL_MARKER} This exact call was already made once in this turn: the human ` +
        'allowed its identical twin, and one allow covers one call. Do not repeat it; continue the ' +
        'rest of the work.'
    : `${PANEL_REFUSAL_MARKER} The human refused this exact call (its identical twin in this ` +
        'turn). Do not retry it and do not work around it; finish the task without it, or end the ' +
        'turn naming what stays blocked.';
}

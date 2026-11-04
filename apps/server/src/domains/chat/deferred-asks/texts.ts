import { DEFERRED_MARKER, PANEL_REFUSAL_MARKER } from '@agentdeck/contracts/deferred-asks';

/**
 * Тексты отказов D-n (решение человека с этапа 10 только записывается — слов
 * продолжения разговору панель больше не шлёт). По-английски: их читает модель (решение
 * D-E, `server-model-english.test.ts`). Каждый отказ начинается меткой —
 * по ней лента, реестр и исход хода узнают, что человека НЕ ждут сейчас.
 */

const NO_MR_MENTION =
  'Do not mention this item in commits, the MR title or the MR description: published text ' +
  'describes the change only.';

/** Первый отказ: вызов поставлен человеку. */
export function deferralDenial(id: string, reason: string): string {
  return (
    `${DEFERRED_MARKER}${id}) This call needs the human's decision (${reason}). It is queued for ` +
    `the human as ${id}. Do not retry it and do not work around it (no other command that does ` +
    'the same thing). Continue everything that does not depend on it. When nothing else remains, ' +
    `end the turn with one line per open item: "Waiting for the human: ${id} — <what it unblocks>". ` +
    "The human's decision is only recorded: the panel does not resume this work or replay the " +
    `call by itself. Keep the MR a draft while an item waits. ${NO_MR_MENTION}`
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

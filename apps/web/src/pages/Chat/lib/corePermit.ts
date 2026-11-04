import { failureOf, failureOfOutcome, failureReason, sendCoreCommand } from '@entities/CoreTask';
import type { CommandDraft } from '@entities/CoreTask';
import type { PendingPermission } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';

type CorePermitCard = NonNullable<PendingPermission['core']>;

/**
 * Вопрос права ядра среди карточек — по номеру вызова. Нет — карточка CLI, её решает маршрут
 * прогона. Одно правило для своей карточки и для карточек детей в хабе: решение ребёнка по вопросу
 * ядра маршрутом прогона получило бы отказ сервера `core_permit_browser_only`.
 */
export function coreCardOf(
  permissions: readonly { toolUseId: string; core?: CorePermitCard }[],
  toolUseId: string,
): CorePermitCard | undefined {
  return permissions.find((p) => p.toolUseId === toolUseId)?.core;
}

/** Маска гранта автоподтверждения: весь репозиторий задачи, только правка. */
export const AUTO_GRANT_GLOBS = ['**'];

/**
 * Решение человека по вопросу права задачи ядра → команды ядру (этап 10, F2b). Ответ `answer` у
 * ядра — human-strict (06 §Authority): его шлёт это окно с числом страницы, не сервер панели.
 * «Разрешить» на вопросе пункта 5 — сначала грант (проект и маска из отказа), затем ответ `grant`:
 * ядро продолжает шаг, только увидев выданное право. Вопрос пункта 3 — ответ `allow`.
 * «Запретить» — ответ `refuse`. `null` — гранта собрать не из чего (ядро не назвало репозиторий
 * или путь).
 */
export function corePermitDrafts(
  card: CorePermitCard,
  behavior: 'allow' | 'deny',
): CommandDraft[] | null {
  const answer = (text: string): CommandDraft => ({
    kind: 'answer',
    taskId: card.taskId,
    fields: { askId: card.askId, answer: text },
  });
  if (behavior === 'deny') return [answer('refuse')];
  if (!card.options.includes('grant')) return [answer(card.options[0] ?? 'allow')];
  if (!card.project || card.globs.length === 0) return null;
  return [
    {
      kind: 'grant',
      taskId: card.taskId,
      fields: { project: card.project, globs: card.globs, ops: ['edit'] },
    },
    answer('grant'),
  ];
}

/** Грант правки всему репозиторию задачи — автоподтверждение. */
export function autoGrantDraft(taskId: string, project: string): CommandDraft {
  return {
    kind: 'grant',
    taskId,
    fields: { project, globs: AUTO_GRANT_GLOBS, ops: ['edit'] },
  };
}

/** Команды по одной, по порядку; первая отвергнутая — причина словами ядра, дальше не идём. */
export async function sendInOrder(drafts: CommandDraft[]): Promise<string | null> {
  for (const draft of drafts) {
    try {
      const failure = failureOfOutcome(await sendCoreCommand(draft));
      if (failure) return failureReason(failure);
    } catch (error) {
      return failureReason(failureOf(error));
    }
  }
  return null;
}

/** Вопросы, на которые ответ уже в пути: второй клик второго конверта не шлёт. */
const sending = new Set<string>();

/**
 * Клик по карточке вопроса права ядра. Карточку снимает ответ, записанный ядром (событие
 * `permissionResolved` с сервера), — не клик: отказ ядра оставляет её на месте с причиной в тосте.
 */
export async function decideCorePermit(
  card: CorePermitCard,
  behavior: 'allow' | 'deny',
): Promise<boolean> {
  const drafts = corePermitDrafts(card, behavior);
  if (!drafts) {
    toast.error(i18n.t('chat.corePermitNoGrant'));
    return false;
  }
  if (sending.has(card.askId)) return false;
  sending.add(card.askId);
  try {
    const refused = await sendInOrder(drafts);
    if (refused !== null) toast.error(i18n.t('chat.corePermitRefused', { reason: refused }));
    return refused === null;
  } finally {
    sending.delete(card.askId);
  }
}

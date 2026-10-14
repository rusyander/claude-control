import type { TFunction } from 'i18next';
import type { SplitGroupReviewClose } from '@agentdeck/contracts/chat-handoff';

/** Строки итога закрытия группы ревью (T13, T6/T11): что осталось в копии и что убрано. */
export interface ReviewCloseLines {
  /** Правки в копии ревью, которое «ничего не правит» — первой строкой, это тревога. */
  dirt?: string;
  /** Полный список имён — по наведению. */
  dirtList?: string;
  scratch: string[];
  stand?: string;
}

export function reviewCloseText(close: SplitGroupReviewClose, t: TFunction): ReviewCloseLines {
  const dirt = close.dirt;
  const shown = dirt?.files.slice(0, 5) ?? [];
  const rest = dirt ? dirt.total - shown.length : 0;
  return {
    ...(dirt && dirt.total > 0
      ? {
          dirt: t('chat.cascade.hub.reviewClose.dirt', {
            count: dirt.total,
            list:
              shown.join(', ') +
              (rest > 0 ? t('chat.cascade.hub.reviewClose.more', { count: rest }) : ''),
          }),
          dirtList: dirt.files.join('\n'),
        }
      : {}),
    scratch: [
      ...(close.scratchRemoved ?? []).map((path) =>
        t('chat.cascade.hub.reviewClose.scratchRemoved', { path }),
      ),
      ...(close.scratchKept ?? []).map((item) =>
        t('chat.cascade.hub.reviewClose.scratchKept', { path: item.path, why: item.why }),
      ),
    ],
    ...(close.standRemoved ? { stand: t('chat.cascade.hub.reviewClose.standRemoved') } : {}),
  };
}

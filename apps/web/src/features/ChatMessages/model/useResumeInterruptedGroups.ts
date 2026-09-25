import { useTranslation } from 'react-i18next';
import { useResumeInterrupted } from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';

/**
 * «Продолжить» оборванные группы разделения (WP1c) — у обеих лент: у Claude и
 * у чужого провайдера хаб один, и кнопка ведёт себя одинаково.
 *
 * Итог говорится числами: сколько продолжено и сколько не вышло. Не вышло —
 * у группы нет сессии (процесс умер в первом ходе) или копии: такую заводят
 * заново, и тост говорит именно это, а не «ошибка».
 */
export interface ResumeInterruptedGroups {
  /** Без номера — все оборванные группы родителя, с номером — одна. */
  resume: (index?: number) => void;
  busy: boolean;
}

export function useResumeInterruptedGroups(input: {
  /** Ключ родителя разделения: запрос адресуется ему. */
  parentChatId?: string | undefined;
  /** Обновить список и дерево после ответа сервера. */
  settle: () => void;
}): ResumeInterruptedGroups {
  const { parentChatId, settle } = input;
  const { t } = useTranslation();
  const mutation = useResumeInterrupted();

  const resume = (index?: number): void => {
    if (!parentChatId || mutation.isPending) return;
    mutation.mutate(
      { parentChatId, ...(index === undefined ? {} : { index }) },
      {
        onSuccess: ({ resumed, refused }) => {
          if (resumed.length > 0) {
            toast.success(t('chat.cascade.hub.resumeInterruptedDone', { count: resumed.length }));
          }
          if (refused.length > 0) {
            toast.error(t('chat.cascade.hub.resumeInterruptedRefused', { count: refused.length }));
          }
          settle();
        },
        onError: (error) =>
          toast.error(
            t('chat.cascade.hub.resumeInterruptedFailed', { message: toErrorMessage(error) }),
          ),
      },
    );
  };

  return { resume, busy: mutation.isPending };
}

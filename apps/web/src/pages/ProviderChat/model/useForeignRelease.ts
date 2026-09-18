import { useTranslation } from 'react-i18next';
import { useReleaseGroup } from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';

/**
 * «Отпустить» группу, которая ждёт предшественников (Т3), у чужого провайдера.
 *
 * Вторая и последняя дверь к стоящей группе: ответ на вопрос разбора двигает
 * только ту, что ждёт ОТВЕТА, а цепочка предшественника может не кончиться
 * никогда — прогон остановили, чат удалили, панель перезапустилась. Решает
 * человек: панель сама никого не отпускает и ничего при этом не сливает.
 *
 * Отдельным модулем — по той же причине, что и карточки ревью рядом: страница
 * собирает ленту, а не ведёт переписку с сервером, и своим объёмом упирается в
 * предел длины. Отказ (409 — группа уже не ждёт) показываем КОДОМ сервера, а
 * не строкой axios: «Request failed with status code 409» человеку не
 * объясняет ничего.
 */
export interface ForeignRelease {
  /** Отпустить группу с этим номером; чата у неё ещё нет, потому номер. */
  release: (index: number) => void;
  busy: boolean;
}

export function useForeignRelease(input: {
  /** Именованный ключ дерева: адресуется отпускание РОДИТЕЛЮ. */
  treeKey?: string;
  /** Обновить список и дерево после ответа сервера. */
  settle: () => void;
}): ForeignRelease {
  const { treeKey, settle } = input;
  const { t } = useTranslation();
  const mutation = useReleaseGroup();

  const release = (index: number): void => {
    if (!treeKey || mutation.isPending) return;
    mutation.mutate(
      { parentChatId: treeKey, index },
      {
        onSuccess: (result) => {
          const started = result.chats.find((chat) => chat.started);
          toast.success(
            started
              ? t('chat.cascade.hub.releaseStarted', { title: started.title })
              : t('chat.cascade.hub.releaseQueued'),
          );
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
          settle();
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.releaseFailed', { message: toErrorMessage(error) })),
      },
    );
  };

  return { release, busy: mutation.isPending };
}

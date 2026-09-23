import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { chatTreeKeys, useCleanupGroup } from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { GroupCopyCleanupProps } from './GroupCopyCleanup.types';
import styles from './ChildStages.module.scss';

/**
 * Уборка копии закрытой группы (Д19) в строке хаба.
 *
 * Сама панель не удаляет ничего: копии копились десятками, и единственное, чего
 * им не хватало, — предложения в том месте, где видно, что группа кончилась.
 * Запрос ведёт сама кнопка, а не страница: хаб стоит в обеих лентах (свой CLI и
 * чужой), и провод через две страницы ради одного нажатия был бы вдвое длиннее
 * самой кнопки. Дерево после ответа перечитывается — строка покажет итог.
 */
export function GroupCopyCleanup({ parentChatId, index, cleaned }: GroupCopyCleanupProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const cleanup = useCleanupGroup();

  if (cleaned) {
    return (
      <Typography variant="caption" color="subtle" data-cleaned-group={cleaned}>
        {t(`chat.cascade.hub.cleaned.${cleaned}`)}
      </Typography>
    );
  }

  const remove = (): void => {
    if (cleanup.isPending) return;
    cleanup.mutate(
      { parentChatId, index },
      {
        onSuccess: (result) => {
          toast.success(t(`chat.cascade.hub.cleaned.${result.branch}`));
          void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.cleanupFailed', { message: toErrorMessage(error) })),
      },
    );
  };

  return (
    <div className={styles.holdActions} data-cleanup-group>
      <Button
        size="sm"
        variant="ghost"
        isLoading={cleanup.isPending}
        title={t('chat.cascade.hub.cleanupHint')}
        onClick={remove}
      >
        {t('chat.cascade.hub.cleanup')}
      </Button>
    </div>
  );
}

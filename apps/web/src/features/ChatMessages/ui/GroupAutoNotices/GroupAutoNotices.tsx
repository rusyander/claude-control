import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { chatTreeKeys, useDismissAutoNotices } from '@entities/ChatTree';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { autoNoticeList } from '../../lib/autoNoticeList';
import type { GroupAutoNoticesProps } from '../GroupAutoNotices.types';
import styles from './GroupAutoNotices.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Строка «разрешено автоматически: …» в хабе (аудит 25.09, L51). Строка
 * разрешений «с отметкой» пропускает запрос группы без карточки, но человек
 * должен видеть, что прошло без него, — строка держится, пока он её не уберёт.
 */
export function GroupAutoNotices({ autoNotices }: GroupAutoNoticesProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dismiss = useDismissAutoNotices();
  const summaries = autoNotices.notices.map((notice) => notice.summary);
  const list = autoNoticeList(summaries);
  // Сведённое «×6» прячет, какие именно файлы и задачи прошли, — они в подсказке.
  const full = list === summaries.join('; ') ? undefined : summaries.join('\n');

  const onDismiss = (): void => {
    if (dismiss.isPending) return;
    dismiss.mutate(
      { parentChatId: autoNotices.parentChatId, index: autoNotices.index },
      {
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all }),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <div className={styles.holdActions} data-auto-notices={autoNotices.notices.length}>
      <Typography variant="caption" color="subtle" as="span" title={full}>
        {t('chat.cascade.hub.autoNotices', { list })}
      </Typography>
      <Button size="sm" variant="ghost" isLoading={dismiss.isPending} onClick={onDismiss}>
        {t('chat.cascade.hub.autoNoticesDismiss')}
      </Button>
    </div>
  );
}

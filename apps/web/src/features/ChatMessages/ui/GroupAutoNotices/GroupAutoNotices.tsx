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

/** Сведённый список и полный — подсказкой, когда «×6» спрятало, что именно прошло. */
function listOf(summaries: readonly string[]): { list: string; full?: string } {
  const list = autoNoticeList(summaries);
  return list === summaries.join('; ') ? { list } : { list, full: summaries.join('\n') };
}

/**
 * Строки «разрешено автоматически: …» и «ответ дан автоматически: …» в хабе
 * (аудит 25.09, L51; F-47). Строка разрешений «с отметкой» пропускает запрос
 * группы без карточки, а в режиме «по плану» панель сама отвечает на её вопрос —
 * человек должен видеть, что прошло без него, и отличать ответ от разрешения.
 * Строки держатся, пока он их не уберёт. Ответ свободным текстом — подписью
 * на языке интерфейса: агенту ушёл английский текст для модели.
 */
export function GroupAutoNotices({ autoNotices }: GroupAutoNoticesProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dismiss = useDismissAutoNotices();
  const allowed = autoNotices.notices
    .filter((notice) => notice.kind !== 'answer')
    .map((notice) => notice.summary);
  const answered = autoNotices.notices
    .filter((notice) => notice.kind === 'answer')
    .map((notice) => (notice.free ? t('chat.cascade.hub.autoAnswerFree') : notice.summary));
  const rows = [
    ...(allowed.length > 0 ? [{ key: 'autoNotices' as const, ...listOf(allowed) }] : []),
    ...(answered.length > 0 ? [{ key: 'autoAnswers' as const, ...listOf(answered) }] : []),
  ];

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
      <div className={styles.lines}>
        {rows.map(({ key, list, full }) => (
          <Typography
            key={key}
            variant="caption"
            color="subtle"
            as="span"
            title={full}
            data-auto-notice-kind={key === 'autoAnswers' ? 'answer' : 'allowed'}
          >
            {t(`chat.cascade.hub.${key}`, { list })}
          </Typography>
        ))}
      </div>
      <Button size="sm" variant="ghost" isLoading={dismiss.isPending} onClick={onDismiss}>
        {t('chat.cascade.hub.autoNoticesDismiss')}
      </Button>
    </div>
  );
}

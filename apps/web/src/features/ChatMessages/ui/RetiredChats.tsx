import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { Stack } from '@shared/ui/stack';
import { GroupCopyCleanup } from './GroupCopyCleanup';
import type { RetiredChatsProps } from './RetiredChats.types';
import styles from './ChildStages.module.scss';

/**
 * «Неактивно» внизу хаба (L20): чаты групп, отброшенных перезапуском
 * разделения. Владелец 24.09: связь с родителем не теряется, но это не строки
 * групп и не корни в списке чатов. Открыть можно — там история работы, которую
 * заменили, — но в счёт групп и в сводку они не идут. Копию, оставленную такой
 * группой, убирают отсюда же (F5.2): хаб её строкой группы уже не покажет.
 */
export function RetiredChats({ chats, onOpen }: RetiredChatsProps) {
  const { t } = useTranslation();
  if (chats.length === 0) return null;

  return (
    <div className={styles.inactive} data-hub-inactive>
      <Typography
        variant="caption"
        color="subtle"
        as="span"
        title={t('chat.cascade.hub.inactiveHint')}
      >
        {t('chat.cascade.hub.inactive', { count: chats.length })}
      </Typography>
      {chats.map((chat) => (
        <Fragment key={chat.chatId}>
          <button
            type="button"
            className={styles.row}
            data-hub-row="retired"
            onClick={() => onOpen(chat.chatId)}
          >
            <StatusDot
              tone={chat.isRunning ? 'success' : 'neutral'}
              pulse={chat.isRunning}
              label={t(chat.isRunning ? 'chat.cascade.hub.running' : 'chat.cascade.hub.idle')}
            />
            <Stack gap="0" className={styles.text}>
              <Typography variant="body-sm" color="subtle" as="span" truncate>
                {chat.title}
              </Typography>
              <Typography variant="caption" color="subtle" as="span" truncate>
                {[chat.branch, ...chat.stages.map((stage) => t(`chat.cascade.stageFull.${stage}`))]
                  .filter(Boolean)
                  .join(' · ')}
              </Typography>
            </Stack>
          </button>
          {chat.retiredCopy && (
            <GroupCopyCleanup parentChatId={chat.retiredCopy.parentChatId} chatId={chat.chatId} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

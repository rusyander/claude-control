import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CoreHopsNotice } from '@entities/CoreTask';
import { CoreChatScreen, CoreChatStart, chatCliOf } from '@features/CoreChat';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { Stack } from '@shared/ui/stack';
import styles from './CoreChatPage.module.scss';

/**
 * Чат через ядро `/core/chat` (этап 10, F2): без `id` — форма нового чата, с `?id=<taskId>` —
 * открытый чат. Номер в адресе — единственное состояние страницы: перезапуск панели или
 * перезагрузка открывают тот же разговор, и лента перечитывается из сеанса ядра целиком.
 */
export function CoreChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id, project, cli, resume } = useSearch({ strict: false }) as {
    id?: string;
    project?: string;
    cli?: string;
    resume?: string;
  };
  const initialCli = chatCliOf(cli);
  const open = (taskId: string) =>
    void navigate({ to: '/core/chat', search: { id: taskId } } as never);

  return (
    <div className={styles.page} data-core-chat-page>
      <PageHeader
        title={t('coreChat.title')}
        subtitle={t('coreChat.subtitle')}
        helpTopic="core"
        actions={
          id ? (
            <Stack direction="row" gap="var(--spacing-xs)" wrap>
              <Button
                variant="secondary"
                leftIcon={<Icon name="layers" size={24} />}
                onClick={() => void navigate({ to: '/core', search: { id } } as never)}
                data-core-chat-open-task
              >
                {t('coreChat.openTask')}
              </Button>
              <Button
                leftIcon={<Icon name="chat" size={24} />}
                onClick={() => void navigate({ to: '/core/chat' } as never)}
                data-core-chat-new
              >
                {t('coreChat.newChat')}
              </Button>
            </Stack>
          ) : undefined
        }
      />
      <CoreHopsNotice />
      {id ? (
        <CoreChatScreen key={id} taskId={id} />
      ) : (
        <CoreChatStart
          onStarted={open}
          {...(project ? { initialProject: project } : {})}
          {...(initialCli ? { initialCli } : {})}
          {...(resume ? { resume } : {})}
        />
      )}
    </div>
  );
}

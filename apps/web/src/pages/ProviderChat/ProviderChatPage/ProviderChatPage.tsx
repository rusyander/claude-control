import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { useProviderRunner } from '@entities/ProviderKeys';
import {
  useDeleteProviderChat,
  usePatchProviderChat,
  useProviderChat,
  useProviderChatProjects,
  useProviderChats,
} from '@entities/ProviderChat';
import { ProviderChatSidebar } from '../ProviderChatSidebar/ProviderChatSidebar';
import { ProviderChatHeader } from '../ProviderChatHeader/ProviderChatHeader';
import { ProviderChatMessages } from '../ProviderChatMessages/ProviderChatMessages';
import styles from './ProviderChatPage.module.scss';

/**
 * Чат чужого CLI (этап 10, F2c). Любой ход идёт в чате ядра (`/core/chat?cli=`): новый
 * разговор, разговор в проекте и «Продолжить» по старому ведут туда, CLI — процесс ядра через
 * его переходник. Здесь остались разговоры, которые вела панель до переезда: список, лента,
 * переименование и удаление. Продолжить такой разговор той же сессией нельзя — его историю
 * держала панель, а не CLI, и ядру нечем подтвердить транскрипт: «Продолжить» открывает новый
 * чат ядра в том же каталоге, и это сказано строкой под лентой.
 */
export function ProviderChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: runner } = useProviderRunner();
  const { data: chats = [], isLoading } = useProviderChats();
  const { data: projects = [], isLoading: isProjectsLoading } = useProviderChatProjects();
  const [activeChatId, setActiveChatId] = useState<string | undefined>(undefined);
  const [isDeleting, setIsDeleting] = useState(false);

  const { data: chat } = useProviderChat(activeChatId);
  const patch = usePatchProviderChat();
  const remove = useDeleteProviderChat();
  const providerName = runner?.providerName ?? '';

  // Первый разговор открывается сам: пустой экран при непустом списке выглядел
  // бы поломкой. Исчезнувший (удалили) — снимается с выбора.
  useEffect(() => {
    if (chats.length === 0) {
      setActiveChatId(undefined);
      return;
    }
    setActiveChatId((current) =>
      current && chats.some((item) => item.id === current) ? current : chats[0]?.id,
    );
  }, [chats]);

  // CLI без хука ядра (aider, continue) получает от ядра названный отказ на экране чата,
  // а не тихий откат на прежний путь.
  const openCoreChat = (project?: string): void =>
    void navigate({
      to: '/core/chat',
      search: {
        ...(runner?.providerId ? { cli: runner.providerId } : {}),
        ...(project ? { project } : {}),
      },
    } as never);

  const continueInCore = (): void => openCoreChat(chat?.workdir);

  const deleteChat = (): void => {
    if (!activeChatId) return;
    remove.mutate(activeChatId, {
      onSuccess: () => {
        setActiveChatId(undefined);
        setIsDeleting(false);
      },
      onError: () => toast.error(t('providerChat.deleteFailed')),
    });
  };

  return (
    <div className={styles.shell}>
      <div className={styles.page}>
        <ProviderChatSidebar
          chats={chats}
          isLoading={isLoading}
          {...(activeChatId ? { activeChatId } : {})}
          onSelect={setActiveChatId}
          onCreate={() => openCoreChat()}
          projects={projects}
          isProjectsLoading={isProjectsLoading}
          providerId={runner?.providerId ?? ''}
          providerName={providerName}
          onStartInProject={openCoreChat}
        />

        <div className={styles.conversation}>
          <ProviderChatHeader
            {...(chat ? { chat } : {})}
            providerName={providerName}
            onRename={(title) => {
              if (activeChatId) patch.mutate({ chatId: activeChatId, title });
            }}
            onDelete={() => setIsDeleting(true)}
            onContinue={continueInCore}
          />

          <ProviderChatMessages
            messages={chat?.messages ?? []}
            providerName={providerName}
            isEmptyState={!activeChatId}
            onCreate={() => openCoreChat()}
            {...(activeChatId ? { mediaChatId: activeChatId } : {})}
            {...(chat?.model ? { mediaModel: chat.model } : {})}
          />

          {activeChatId && (
            <Stack padding="var(--spacing-xs) var(--spacing-xl)" data-provider-chat-history-note>
              <Typography variant="caption" color="subtle">
                {t('providerChat.history.note', { provider: providerName })}
              </Typography>
            </Stack>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={isDeleting}
        onOpenChange={setIsDeleting}
        onConfirm={deleteChat}
        title={t('providerChat.deleteTitle')}
        description={t('providerChat.deleteDescription')}
        confirmLabel={t('providerChat.delete')}
        isPending={remove.isPending}
      />
    </div>
  );
}

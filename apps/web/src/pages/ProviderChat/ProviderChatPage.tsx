import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { FolderPicker } from '@features/FolderPicker';
import { useProviderRunner } from '@entities/ProviderKeys';
import {
  useCreateProviderChat,
  useDeleteProviderChat,
  usePatchProviderChat,
  useProviderChat,
  useProviderChatRun,
  useProviderChats,
} from '@entities/ProviderChat';
import { ProviderChatSidebar } from './ProviderChatSidebar';
import { ProviderChatHeader } from './ProviderChatHeader';
import { ProviderChatMessages } from './ProviderChatMessages';
import { ProviderChatComposer } from './ProviderChatComposer';
import styles from './ProviderChatPage.module.scss';

/**
 * Чат чужого провайдера: разговоры, память между вопросами и ответ по мере
 * печати.
 *
 * Чат Claude сюда не заходит — у него собственная страница и собственный поток
 * событий. Разделение не косметическое: у Claude источник правды — его же
 * транскрипты, здесь переписку ведёт панель, потому что своей читаемой истории
 * у этих CLI нет.
 */
export function ProviderChatPage() {
  const { t } = useTranslation();
  const { data: runner } = useProviderRunner();
  const { data: chats = [], isLoading } = useProviderChats();
  const [activeChatId, setActiveChatId] = useState<string | undefined>(undefined);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [picker, setPicker] = useState<'none' | 'workdir' | 'file'>('none');
  const [isDeleting, setIsDeleting] = useState(false);

  const { data: chat } = useProviderChat(activeChatId);
  const create = useCreateProviderChat();
  const patch = usePatchProviderChat();
  const remove = useDeleteProviderChat();
  const run = useProviderChatRun(activeChatId);

  const providerName = runner?.providerName ?? '';
  const isBlocked = runner?.mode === 'none';

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

  useEffect(() => {
    if (run.error) toast.error(run.error);
  }, [run.error]);

  const startChat = (): void => {
    create.mutate(
      {},
      {
        onSuccess: (created) => setActiveChatId(created.id),
        onError: () => toast.error(t('providerChat.createFailed')),
      },
    );
  };

  const onPick = (path: string): void => {
    if (picker === 'workdir' && activeChatId) {
      patch.mutate({ chatId: activeChatId, workdir: path });
    } else if (picker === 'file') {
      setAttachments((prev) => (prev.includes(path) ? prev : [...prev, path]));
    }
    setPicker('none');
  };

  const send = (text: string): void => {
    void run.send(text, attachments);
    setAttachments([]);
  };

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
          onCreate={startChat}
          isCreating={create.isPending}
        />

        <div className={styles.conversation}>
          <ProviderChatHeader
            {...(chat ? { chat } : {})}
            providerName={providerName}
            {...(runner ? { runner } : {})}
            isRunning={run.isRunning}
            onRename={(title) => {
              if (activeChatId) patch.mutate({ chatId: activeChatId, title });
            }}
            onPickWorkdir={() => setPicker('workdir')}
            onDelete={() => setIsDeleting(true)}
            onStop={() => void run.stop()}
          />

          {isBlocked && (
            <Stack padding="var(--spacing-2xs) var(--spacing-xl)">
              <Typography variant="caption" color="subtle">
                {t('providerChat.noneHint')}
              </Typography>
            </Stack>
          )}

          <ProviderChatMessages
            messages={chat?.messages ?? []}
            providerName={providerName}
            partial={run.partial}
            isRunning={run.isRunning}
            isEmptyState={!activeChatId}
            onCreate={startChat}
            isCreating={create.isPending}
          />

          <ProviderChatComposer
            attachments={attachments}
            onAttach={() => setPicker('file')}
            onClearAttachments={() => setAttachments([])}
            onSend={send}
            isRunning={run.isRunning}
            isBlocked={isBlocked || !activeChatId}
          />
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

      <FolderPicker
        isOpen={picker !== 'none'}
        onOpenChange={(open) => !open && setPicker('none')}
        onPick={onPick}
        mode={picker === 'file' ? 'file' : 'dir'}
        title={picker === 'file' ? t('providerChat.attach') : t('providerChat.workdir')}
        hint={picker === 'file' ? t('providerChat.attachHint') : t('providerChat.workdirHint')}
      />
    </div>
  );
}

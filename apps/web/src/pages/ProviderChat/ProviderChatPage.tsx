import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@claude-control/contracts/task-split';
import type { HandoffProposal } from '@claude-control/contracts/chat-handoff';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { FolderPicker } from '@features/FolderPicker';
import { useProviderRunner } from '@entities/ProviderKeys';
import {
  providerChatKeys,
  useCreateProviderChat,
  useDeleteProviderChat,
  usePatchProviderChat,
  useProviderChat,
  useProviderChatRun,
  useProviderChats,
} from '@entities/ProviderChat';
import { useSplitTasks } from '@entities/ChatSplit';
import { useStartHandoff } from '@entities/ChatHandoff';
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
  const queryClient = useQueryClient();
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

  /**
   * Разделение задач по чатам. Копии репозитория и сами разговоры заводит тот же
   * серверный маршрут, что и у Claude, — вид чата решает активный провайдер, а
   * не клиент. Здесь остаётся освежить список: новые разговоры уже созданы.
   */
  const split = useSplitTasks();
  const splitTasks = (proposal: TaskSplitProposal, options: { startRuns: boolean }): void => {
    const projectPath = chat?.workdir;
    if (!projectPath) return;
    split.mutate(
      { projectPath, proposal, startRuns: options.startRuns, allowEdits: true },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
          if (result.chats.length > 0) {
            toast.success(t('chat.split.done', { count: result.chats.length }));
          }
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
        },
        onError: (error) => toast.error(t('chat.split.failedAll', { message: error.message })),
      },
    );
  };

  /**
   * Продолжение в чистой сессии. Здесь это буквально новый разговор панели с тем
   * же рабочим каталогом: своей истории у чужих CLI нет, память ведёт панель, —
   * значит, пустой разговор и есть чистый лист. Заводит его тот же серверный
   * маршрут, что и у Claude.
   */
  const handoff = useStartHandoff();
  const continueClean = (proposal: HandoffProposal, options: { startRun: boolean }): void => {
    const projectPath = chat?.workdir;
    if (!projectPath) return;
    handoff.mutate(
      {
        projectPath,
        ...(activeChatId ? { chatId: activeChatId } : {}),
        proposal,
        startRun: options.startRun,
        allowEdits: true,
      },
      {
        onSuccess: (started) => {
          void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
          toast.success(started.started ? t('chat.handoff.done') : t('chat.handoff.doneDraft'));
        },
        onError: (error) => toast.error(t('chat.handoff.failed', { message: error.message })),
      },
    );
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
            {...(chat?.workdir ? { onSplit: splitTasks } : {})}
            onKeepHere={() => send(t('chat.split.keepHerePrompt'))}
            isSplitPending={split.isPending}
            {...(chat?.workdir ? { onHandoff: continueClean } : {})}
            onHandoffKeepHere={() => send(t('chat.handoff.keepHerePrompt'))}
            isHandoffPending={handoff.isPending}
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

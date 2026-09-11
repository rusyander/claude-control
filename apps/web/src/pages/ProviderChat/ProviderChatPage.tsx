import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import type { HandoffProposal } from '@agentdeck/contracts/chat-handoff';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
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
  useRestartProviderChat,
} from '@entities/ProviderChat';
import { useSplitTasks } from '@entities/ChatSplit';
import {
  chatTreeKeys,
  useAnswerHold,
  useChatTree,
  useCheckOverlap,
  usePauseTree,
  useResumeTree,
} from '@entities/ChatTree';

import { useStartHandoff } from '@entities/ChatHandoff';
import { ProviderChatSidebar } from './ProviderChatSidebar';
import { ProviderChatHeader } from './ProviderChatHeader';
import { ProviderChatMessages } from './ProviderChatMessages';
import { ProviderChatComposer } from './ProviderChatComposer';
import { collectForeignStages } from './lib/foreignStages';
import { useForeignReviews } from './model/useForeignReviews';
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
   * Перезапуск разговора в чистом виде (Т7). Сессии у чужого CLI нет, поэтому
   * панель заводит НОВЫЙ разговор с контрольной точкой и исходным заданием — и
   * так это и называется человеку.
   *
   * Ответа два. `started` — продолжение уже идёт, и вкладка переключается на
   * него: смотреть человеку надо туда. `requested` — файл-опора ещё не готов, и
   * просьба его записать уходит ОБЫЧНЫМ сообщением в этот же разговор: тем же
   * путём, что и любая реплика человека, с той же моделью и теми же правами.
   */
  const restart = useRestartProviderChat();
  const restartSession = (): void => {
    if (!activeChatId || restart.isPending) return;
    restart.mutate(activeChatId, {
      onSuccess: (outcome) => {
        if (outcome.mode === 'started' && outcome.chatId) {
          setActiveChatId(outcome.chatId);
          toast.success(t('providerChat.restartDone'));
          return;
        }
        if (outcome.prompt) send(outcome.prompt);
        toast.info(t('providerChat.restartRequested'));
      },
      onError: (error) => toast.error(t('providerChat.restartFailed', { message: error.message })),
    });
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
      {
        projectPath,
        proposal,
        startRuns: options.startRuns,
        allowEdits: true,
        // Родитель обязателен: без него связей не будет, а с ними — ни дерева,
        // ни хаба, ни стадий. Ключ панель именует сама (`codex:c1a2…`).
        ...(activeChatId ? { parentChatId: activeChatId } : {}),
      },
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

  /**
   * Дерево этого разговора: дети разделения, их звенья и состояние. Ключ
   * именованный — связь чужого чата не находится по «голому» идентификатору.
   *
   * Спрашивается у любого открытого разговора, а не только у известного
   * родителя: узнать про детей заранее неоткуда — своих связей список чужих
   * разговоров не несёт, — а ответ пустому дереву стоит одного чтения состояния
   * и ничего не рисует.
   */
  const treeKey =
    runner?.providerId && activeChatId
      ? foreignChatKey(runner.providerId, activeChatId)
      : undefined;
  const tree = useChatTree(treeKey, Boolean(treeKey));
  /**
   * Хаб — только у КОРНЯ дерева. Дерево поднимается от любого ключа ВВЕРХ, до
   * разговора без связи, поэтому у ребёнка приезжает дерево его родителя — то
   * же самое, что у родителя. Без этой проверки лента группы показывала бы
   * пульт всего разделения, включая соседей, которых человек здесь не решает.
   */
  const isRoot = Boolean(treeKey) && tree.data?.root === treeKey;
  const stages = isRoot ? collectForeignStages(tree.data) : [];

  /**
   * «Остановить всё» и «Продолжить всё» (Т5). Дерево одно на любого провайдера,
   * и кнопки те же — гасят идущие прогоны групп и держат очередь автостартов на
   * сервере. Продолжение у чужого CLI не «с того же места»: сессии нет, поэтому
   * задание уходит заново, и на карточке это сказано словами.
   */
  const pause = usePauseTree();
  const resume = useResumeTree();
  const settleTree = (): void => {
    void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(treeKey ?? '') });
  };
  const treeFailed = (error: unknown): void => {
    toast.error(
      t('chat.cascade.tree.failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  /**
   * Ревью MR по ссылке (Т6): карточки решения открытого разговора. Живёт в
   * `model/useForeignReviews` — здесь остаётся то, чем страница СОБИРАЕТСЯ, а не
   * то, как она решает; правило «родителю все, группе своё» одно на оба чата.
   */
  const reviews = useForeignReviews({
    ...(tree.data ? { tree: tree.data } : {}),
    ...(treeKey ? { treeKey } : {}),
    isRoot,
    settle: settleTree,
  });

  const pauseAll = (): void => {
    if (!treeKey || pause.isPending) return;
    pause.mutate(treeKey, {
      onSuccess: (result) => {
        toast.success(t('chat.cascade.tree.pausedToast', { count: result.stopped }));
        settleTree();
      },
      onError: treeFailed,
    });
  };
  /**
   * Ответ человека на вопрос разбора (Т3). Адресуется РОДИТЕЛЮ именованным
   * ключом и номером группы: у стоящей группы чата ещё нет — копия заводится
   * после ответа, и ответ уезжает в её план и в работу заметкой.
   */
  const hold = useAnswerHold();
  const answerHold = (index: number, answer: string): void => {
    if (!treeKey || hold.isPending) return;
    hold.mutate(
      { parentChatId: treeKey, index, answer },
      {
        onSuccess: (result) => {
          const started = result.chats.find((chat) => chat.started);
          toast.success(
            started
              ? t('chat.cascade.hub.holdStarted', { title: started.title })
              : t('chat.cascade.hub.holdQueued'),
          );
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
          settleTree();
        },
        onError: (error) =>
          toast.error(
            t('chat.cascade.hub.holdFailed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
      },
    );
  };

  /**
   * Сверка веток групп (Т4). Считает её сервер запросами к git по концу цепочки
   * каждой группы, а кнопка — способ пересчитать раньше: работа могла лечь, а
   * человек уже смотрит. Ответ приезжает и сам, деревом, поэтому здесь нужен
   * только исход нажатия: пусто — сказать об этом, иначе кнопка выглядит
   * ничего не сделавшей.
   */
  const overlap = useCheckOverlap();
  const checkOverlap = (): void => {
    if (!treeKey || overlap.isPending) return;
    overlap.mutate(treeKey, {
      onSuccess: (view) => {
        if (view.files.length === 0) toast.success(t('chat.cascade.overlap.clean'));
        void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(treeKey) });
      },
      onError: (error) =>
        toast.error(
          t('chat.cascade.overlap.failed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
    });
  };

  const resumeAll = (): void => {
    if (!treeKey || resume.isPending) return;
    resume.mutate(treeKey, {
      onSuccess: (result) => {
        toast.success(
          t('chat.cascade.tree.resumedToastForeign', {
            resumed: result.resumed,
            flushed: result.flushed,
          }),
        );
        settleTree();
      },
      onError: treeFailed,
    });
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
            {...(chat?.workdir ? { onRestart: restartSession } : {})}
            isRestarting={restart.isPending}
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
            stages={stages}
            {...(tree.data ? { tree: tree.data } : {})}
            onOpenChild={setActiveChatId}
            onPauseAll={pauseAll}
            onResumeAll={resumeAll}
            treeBusy={pause.isPending || resume.isPending}
            onAnswerHold={answerHold}
            holdBusy={hold.isPending}
            onCheckOverlap={checkOverlap}
            overlapBusy={overlap.isPending}
            reviews={reviews.items}
            onReviewDecide={reviews.decide}
            onReviewPush={reviews.push}
            reviewBusy={reviews.busy}
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

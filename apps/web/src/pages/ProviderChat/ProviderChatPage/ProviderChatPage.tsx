import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { HandoffProposal } from '@agentdeck/contracts/chat-handoff';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { FolderPicker } from '@features/FolderPicker';
import { useProviderRunner } from '@entities/ProviderKeys';
import { activeProvider, useProviders } from '@entities/Provider';
import {
  providerChatKeys,
  useCreateProviderChat,
  useDeleteProviderChat,
  usePatchProviderChat,
  useProviderChat,
  useProviderChatProjects,
  useProviderChatRun,
  useProviderChats,
  useRestartProviderChat,
} from '@entities/ProviderChat';
import { useStartHandoff } from '@entities/ChatHandoff';
import { MediaDeckCard, storeAgentImageFiles, useChatMedia } from '@entities/Media';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
import { MediaFeedCard, PermissionCard } from '@features/ChatMessages';
import { TurnToolHintLine, useTurnToolHint } from '@entities/Platform';
import { foreignConsumerId } from '@agentdeck/contracts/platform-consumers';
import { ProviderChatSidebar } from '../ProviderChatSidebar/ProviderChatSidebar';
import { ProviderChatHeader } from '../ProviderChatHeader/ProviderChatHeader';
import { ProviderChatGroupPicker } from '../ProviderChatGroupPicker/ProviderChatGroupPicker';
import { ProviderChatMessages } from '../ProviderChatMessages/ProviderChatMessages';
import { ProviderChatComposer } from '../ProviderChatComposer/ProviderChatComposer';
import { useForeignSplitHub } from '../model/useForeignSplitHub';
import styles from './ProviderChatPage.module.scss';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

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
  // Группа едет к чужому CLI только слоем: у CLI без слоя выбирать её незачем.
  const groupsModel = activeProvider(useProviders().data)?.groupsModel;
  const { data: chats = [], isLoading } = useProviderChats();
  const { data: projects = [], isLoading: isProjectsLoading } = useProviderChatProjects();
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
  // Вызовы чужого CLI видит только шлюз контура — их счёт приезжает в реплике
  // (`contourToolCalls`). Проваленный ответ — не ход агента, о нём молчим.
  const lastReply = chat?.messages.at(-1);
  const toolHint = useTurnToolHint(
    runner?.providerId ? foreignConsumerId(runner.providerId) : '',
    lastReply?.role === 'assistant' && !lastReply.failed
      ? { toolCalls: lastReply.contourToolCalls, text: lastReply.content }
      : undefined,
    run.isRunning,
  );
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

  /**
   * Новый разговор активного провайдера в каталоге проекта — в том числе
   * проекта, где до сих пор работал только Claude. Каталог проверяет сервер
   * (тот же `POST`, что у кнопки «Новый»); отказ называется, а не глотается.
   */
  const startInProject = (path: string): void => {
    create.mutate(
      { workdir: path },
      {
        onSuccess: (created) => setActiveChatId(created.id),
        onError: (error) =>
          toast.error(t('providerChat.projects.startFailed', { message: toErrorMessage(error) })),
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

  const send = async (text: string, images: AgentImage[] = []): Promise<boolean> => {
    let paths = attachments;
    // Картинки чужой CLI читает сам — файлами: панель кладёт их к себе и
    // добавляет пути к вложениям этой отправки. Не дошли — сообщение не уходит,
    // текст и чипы остаются в поле.
    if (images.length > 0) {
      try {
        const stored = await storeAgentImageFiles(images);
        paths = [...attachments, ...stored.map((file) => file.path)];
      } catch (error) {
        toast.error(t('attach.uploadFailed', { message: toErrorMessage(error) }));
        return false;
      }
    }
    void run.send(text, paths);
    setAttachments([]);
    return true;
  };

  /**
   * Режимы «Картинка» и «Презентация» здесь тоже работают, и рабочая дорога у
   * чужого CLI — просьба к самому агенту: панель отправляет обычное сообщение, а
   * ответ приезжает блоком и становится карточкой в ленте. Тот же хук, что и у
   * Claude: второй расчёт доступности разошёлся бы с настоящим маршрутом.
   *
   * Дороги, по которым панель делает сама (контур, ручка картинок, свой
   * эндпоинт), остаются доступны — их результат показывается карточкой над полем
   * ввода: правого столбца у этой страницы нет, а обещать в меню «нарисует
   * контур» и не показать результат нельзя.
   */
  const media = useChatMedia({
    host: 'provider-chat',
    chatId: activeChatId ?? '',
    ask: (text) => {
      if (!activeChatId || run.isRunning) return false;
      send(text);
      return true;
    },
  });

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

  // Разделение и хаб групп — своим хуком: страница собирает ленту (W3-5).
  const { splitTasks, hub } = useForeignSplitHub({
    ...(runner?.providerId ? { providerId: runner.providerId } : {}),
    ...(activeChatId ? { activeChatId } : {}),
    ...(chat?.workdir ? { workdir: chat.workdir } : {}),
    allowEdits: chat?.allowEdits === true,
  });

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
        // Права продолжения — переключатель ЭТОГО разговора, как у Claude.
        allowEdits: chat?.allowEdits === true,
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
          projects={projects}
          isProjectsLoading={isProjectsLoading}
          providerId={runner?.providerId ?? ''}
          providerName={providerName}
          onStartInProject={startInProject}
        />

        <div className={styles.conversation}>
          <ProviderChatHeader
            {...(chat ? { chat } : {})}
            providerName={providerName}
            providerId={runner?.providerId ?? ''}
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
            {...(runner?.editsToggle && activeChatId
              ? {
                  allowEdits: chat?.allowEdits === true,
                  onAllowEditsChange: (next: boolean) =>
                    patch.mutate({ chatId: activeChatId, allowEdits: next }),
                  ...(runner.editsWhenOff ? { editsWhenOff: runner.editsWhenOff } : {}),
                }
              : {})}
          />

          {groupsModel === 'run-layer' && activeChatId && runner?.providerId && (
            <ProviderChatGroupPicker
              providerId={runner.providerId}
              chatId={activeChatId}
              workdir={chat?.workdir}
            />
          )}

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
            queued={run.queued}
            onCancelQueued={(queuedId) => void run.cancelQueued(queuedId)}
            queueHeld={run.queueHeld}
            onSendQueued={(queuedId) => void run.sendQueued(queuedId)}
            isEmptyState={!activeChatId}
            onCreate={startChat}
            isCreating={create.isPending}
            {...(chat?.workdir ? { onSplit: splitTasks } : {})}
            onKeepHere={() => send(t('chat.split.keepHerePrompt'))}
            {...(chat?.workdir ? { onHandoff: continueClean } : {})}
            onHandoffKeepHere={() => send(t('chat.handoff.keepHerePrompt'))}
            isHandoffPending={handoff.isPending}
            {...hub}
            onOpenChild={setActiveChatId}
            {...(activeChatId ? { mediaChatId: activeChatId } : {})}
            {...(chat?.model ? { mediaModel: chat.model } : {})}
            {...(media.topic ? { mediaTopic: media.topic } : {})}
            mediaRevision={media.revision}
          />

          {/* Просьбы CLI о разрешении — той же карточкой, что у Claude: работа
              стоит, пока человек не решит. */}
          {run.permissions.length > 0 && (
            <Stack padding="0 var(--spacing-xl)">
              <PermissionCard
                permissions={run.permissions.map((ask) => ({
                  toolUseId: ask.id,
                  toolName: ask.tool ?? providerName,
                  input: { command: ask.title ?? ask.tool ?? providerName },
                }))}
                onDecide={(askId, decision) => void run.answerPermission(askId, decision)}
              />
            </Stack>
          )}

          {toolHint && (
            <Stack padding="0 var(--spacing-xl)">
              <TurnToolHintLine hint={toolHint} />
            </Stack>
          )}

          {media.shownImage && (
            <Stack padding="0 var(--spacing-xl)">
              <MediaFeedCard picture={media.shownImage} onClose={media.close} />
            </Stack>
          )}
          {media.shownDeck && (
            <Stack padding="0 var(--spacing-xl)">
              <MediaDeckCard
                deck={media.shownDeck}
                onClose={media.close}
                onRevise={media.revision.onStart}
              />
            </Stack>
          )}

          <ProviderChatComposer
            attachments={attachments}
            onAttach={() => setPicker('file')}
            onClearAttachments={() => setAttachments([])}
            // В неттекстовом режиме отправка делает, а не пишет агенту: на дороге
            // агента это всё равно обычное сообщение, но собранное сервером.
            onSend={media.isMediaMode ? (text) => media.submit(text) : send}
            isRunning={run.isRunning}
            isSteerable={run.isSteerable}
            isBlocked={isBlocked || !activeChatId}
            modes={media.modes}
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

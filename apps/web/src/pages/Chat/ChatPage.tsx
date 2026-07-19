import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { ChatList } from '@features/ChatList';
import { ChatMessages } from '@features/ChatMessages';
import { ChatComposer } from '@features/ChatComposer';
import { ArtifactPreview } from '@features/ArtifactPreview';
import {
  useChats,
  useChatMessages,
  useArtifacts,
  useRefreshChat,
} from '@entities/Chat/api/ChatApi';
import { useChatStream } from '@entities/Chat/model/useChatStream';
import { ResizeHandle } from '@shared/ui/resize-handle';
import styles from './ChatPage.module.scss';

const PREVIEW_WIDTH_KEY = 'claude-control:preview-width';

/**
 * Полноценный чат с Claude Code. Переписку хранит сам Claude Code в своих
 * транскриптах, поэтому здесь нет отдельной базы: список читается из них,
 * а продолжение разговора идёт через тот же механизм сессий, что и в терминале.
 */
export function ChatPage() {
  const { t } = useTranslation();

  const [activeChat, setActiveChat] = useState<ChatSummary | undefined>(undefined);
  // Новый чат существует только на клиенте, пока не отправлено первое
  // сообщение: идентификатор сессии выдаёт сам Claude Code.
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<Artifact | undefined>(undefined);
  // Отправленное показываем сразу: в транскрипт оно попадёт только после
  // ответа, а ждать этого, глядя на пустую ленту, невозможно.
  const [pending, setPending] = useState<ChatMessage[]>([]);
  // Ширину превью пользователь настраивает под себя, и она запоминается:
  // для страницы удобна одна ширина, для кода — другая.
  const [previewWidth, setPreviewWidth] = useState(
    () => Number(localStorage.getItem(PREVIEW_WIDTH_KEY)) || 520,
  );

  const chatId = activeChat?.id ?? draftId;

  const chats = useChats();
  const messages = useChatMessages(activeChat?.id);
  const artifacts = useArtifacts(chatId);
  const refresh = useRefreshChat(chatId);

  // Ответ дописывается в транскрипт — после его окончания перечитываем историю.
  const onFinished = useCallback(() => {
    window.setTimeout(refresh, 500);
  }, [refresh]);

  const stream = useChatStream(onFinished);

  // Идентификатор сессии выдаёт Claude Code, поэтому новый чат становится
  // настоящим только после первого ответа: тогда он находится в списке, и
  // дальше переписка читается уже из транскрипта.
  useEffect(() => {
    const sessionId = stream.state.sessionId;
    if (!sessionId || activeChat || stream.state.isRunning) return;

    const created = chats.data?.find((chat) => chat.id === sessionId);
    if (!created) return;

    setActiveChat(created);
    setDraftId(undefined);
    setPending([]);
  }, [stream.state.sessionId, stream.state.isRunning, chats.data, activeChat]);

  // Ответ живёт в двух местах: пока он печатается — в потоке, а после того как
  // Claude Code запишет его в транскрипт — в истории. Как только он появился
  // в истории, поток нужно погасить, иначе ответ покажется дважды.
  useEffect(() => {
    if (stream.state.isRunning || !stream.state.text) return;

    const lastAnswer = [...(messages.data ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant');

    const answerText = lastAnswer?.blocks.find((block) => block.type === 'text');
    if (answerText?.type === 'text' && answerText.text.startsWith(stream.state.text.slice(0, 40))) {
      stream.reset();
      setPending([]);
    }
  }, [messages.data, stream.state.isRunning, stream.state.text]);

  const startNewChat = (): void => {
    setActiveChat(undefined);
    setDraftId(`new-${Date.now()}`);
    setPreview(undefined);
    setPending([]);
    stream.reset();
    setInput('');
  };

  const send = (files: { name: string; base64: string }[]): void => {
    if (!chatId) {
      startNewChat();
      return;
    }

    const prompt = input;
    setInput('');
    setPending((current) => [
      ...current,
      {
        id: `pending-${Date.now()}`,
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        timestamp: new Date().toISOString(),
      },
    ]);

    void stream.send({
      chatId,
      prompt,
      // Продолжаем существующую сессию; у нового чата её ещё нет.
      sessionId: activeChat?.id ?? stream.state.sessionId,
      files,
    });
  };

  return (
    <div
      className={`${styles.page} ${preview ? styles.pageWithPreview : ''}`}
      // Колонки: список, лента, разделитель и превью заданной ширины.
      style={
        preview ? { gridTemplateColumns: `300px minmax(0, 1fr) auto ${previewWidth}px` } : undefined
      }
    >
      <ChatList
        chats={chats.data ?? []}
        isLoading={chats.isLoading}
        activeId={activeChat?.id}
        onSelect={(chat) => {
          setActiveChat(chat);
          setDraftId(undefined);
          setPreview(undefined);
          stream.reset();
        }}
        onCreate={startNewChat}
      />

      <div className={styles.main}>
        <div className={styles.header}>
          <Stack gap="var(--spacing-3xs)" className={styles.headerText}>
            <Typography variant="body" weight="medium" className={styles.title}>
              {activeChat?.title ?? t('chat.newChat')}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {activeChat?.projectPath ?? t('chat.sandboxHint')}
            </Typography>
          </Stack>

          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            {stream.state.costUsd !== undefined && (
              <Badge tone="neutral">${stream.state.costUsd.toFixed(3)}</Badge>
            )}
            {stream.state.limitResetsAt !== undefined && (
              <Badge tone="info">
                {t('chat.limitResets', { time: formatTime(stream.state.limitResetsAt) })}
              </Badge>
            )}
            <Button
              variant="ghost"
              iconOnly
              icon={<Icon name="refresh" size={24} />}
              aria-label={t('common.refresh')}
              onClick={refresh}
            />
          </Stack>
        </div>

        {(artifacts.data?.length ?? 0) > 0 && (
          <div className={styles.artifacts} data-artifacts>
            {artifacts.data?.map((artifact) => (
              <Button
                key={artifact.name}
                size="sm"
                variant="ghost"
                leftIcon={<Icon name="file" size={20} />}
                onClick={() => setPreview(artifact)}
              >
                {artifact.name}
              </Button>
            ))}
          </div>
        )}

        {chatId ? (
          <ChatMessages
            messages={[...(messages.data ?? []), ...pending]}
            stream={stream.state}
            isLoading={messages.isLoading}
            onEdit={setInput}
          />
        ) : (
          <div className={styles.empty}>
            <Stack gap="var(--spacing-sm)" align="center">
              <Icon name="chat" size={40} />
              <Typography variant="heading-sm">{t('chat.emptyTitle')}</Typography>
              <Typography color="muted">{t('chat.emptyText')}</Typography>
              <Button variant="primary" onClick={startNewChat}>
                {t('chat.newChat')}
              </Button>
            </Stack>
          </div>
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={send}
          onStop={() => chatId && stream.stop(chatId)}
          isRunning={stream.state.isRunning}
        />
      </div>

      {preview && chatId && (
        <>
          <ResizeHandle
            width={previewWidth}
            min={320}
            max={1000}
            label={t('chat.resizePreview')}
            onResize={(width) => {
              setPreviewWidth(width);
              localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
            }}
          />
          <ArtifactPreview
            chatId={chatId}
            artifact={preview}
            onClose={() => setPreview(undefined)}
          />
        </>
      )}
    </div>
  );
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { useSpeechRecognition } from '@shared/hooks/use-speech-recognition';
import { useMicLevels } from '@shared/hooks/use-mic-levels';
import { speechErrorMessageKey } from '@shared/lib/speech';
import { VoiceWave } from '@shared/ui/voice-wave';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import {
  ImageAttachButton,
  ImageAttachTray,
  ImageAttachZone,
  SentImageNames,
  useImageAttach,
} from '@shared/ui/image-attach';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
import {
  assistHistory,
  keptSecretMisses,
  type AssistantApplyReport,
  type AssistTurn,
} from '@shared/lib/assistant-fields';
import { AssistantMissed } from './assistant-missed';
import styles from './assistant-chat.module.scss';
import type { AssistantChatProps, AssistantMessage } from './assistant-chat.types';

interface AssistResponse {
  reply: string;
  fields: Record<string, unknown>;
  /** Поля, где маску секрета вернуть не удалось: форма их не трогает. */
  kept?: string[];
  error?: string;
}

/**
 * Чат-помощник рядом с формой. Работает через сам Claude Code по вашей
 * подписке, поэтому отдельных ключей не требует. Ответ приходит структурой
 * «пояснение + значения полей», и поля применяются к форме сразу.
 *
 * Переписка живёт только пока открыто окно: помощник нужен для одного
 * заполнения, а не для длинной истории. Сессии у помощника нет (лёгкое окно,
 * D4 28.09) — прежние реплики едут в каждом запросе (`history`).
 */
export function AssistantChat({ kind, fields, schema, onApply, placeholder }: AssistantChatProps) {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');

  const feedRef = useRef<HTMLDivElement>(null);
  const speech = useSpeechRecognition(i18n.language === 'en' ? 'en-US' : 'ru-RU');

  // Панель записи показывается и во время финализации: пока речь переводится
  // в текст, кнопки заблокированы, но пользователь видит, что идёт обработка.
  const isVoiceMode = speech.listening || speech.finalizing;
  const levels = useMicLevels(speech.listening);
  // Ошибка распознавания: режим записи закрывается сам, и без этой строки отказ
  // микрофона не доходил до человека вовсе. null — тишина/отмена, о них молчим.
  const speechErrorKey = speechErrorMessageKey(speech.error);

  /** Отмена: запись прекращается, надиктованное не попадает в поле. */
  const cancelVoice = (): void => {
    speech.stop();
    speech.reset();
  };

  // Распознанный голос попадает в поле ввода: пользователь видит текст
  // до отправки и может его поправить.
  useEffect(() => {
    if (speech.transcript) setInput(speech.transcript);
  }, [speech.transcript]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const ask = useMutation({
    mutationFn: async ({
      message,
      images,
      history,
    }: {
      message: string;
      images: AgentImage[];
      history: AssistTurn[];
    }) => {
      const { data } = await apiClient.post<AssistResponse>(
        '/assist',
        {
          kind,
          message,
          fields,
          schema,
          history,
          // Картинка едет блоком в самом запросе: «заполни по снимку» — обычная просьба.
          ...(images.length > 0 ? { images } : {}),
        },
        { timeout: 200_000 },
      );
      return data;
    },
    onSuccess: (data) => {
      const proposed = Object.keys(data.fields ?? {});
      // `void` у onApply — окна без отчёта (витрина): тогда поля — ключи ответа.
      const report =
        proposed.length > 0
          ? (onApply(data.fields) as AssistantApplyReport | undefined)
          : undefined;
      const changed = report ? report.applied : proposed;
      const missed = [...(report?.missed ?? []), ...keptSecretMisses(data.kept)];

      setMessages((current) => [
        ...current,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: data.error ? t('assistant.failed') : data.reply || t('assistant.noReply'),
          ...(data.error ? { failed: true } : {}),
          changedFields: changed,
          ...(missed.length > 0 ? { missed } : {}),
        },
      ]);
    },
  });

  const attach = useImageAttach({ disabled: ask.isPending });

  const send = (): void => {
    const text = input.trim();
    if (!text || ask.isPending || attach.isPreparing) return;

    const images = attach.images;
    // История — до этой реплики: сама просьба едет отдельным полем.
    const history = assistHistory(messages);
    setMessages((current) => [
      ...current,
      {
        id: `u-${Date.now()}`,
        role: 'user',
        text,
        ...(images.length > 0 ? { images: images.map((image) => image.name) } : {}),
      },
    ]);
    setInput('');
    speech.reset();
    attach.clear();
    ask.mutate({ message: text, images, history });
  };

  return (
    <div className={styles.root}>
      <Stack className={styles.header} gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="help" size={24} />
          <Typography variant="body-sm" weight="medium" as="span">
            {t('assistant.title')}
          </Typography>
        </Stack>
        <Typography variant="caption" color="subtle">
          {t('assistant.subtitle')}
        </Typography>
      </Stack>

      <div className={styles.feed} ref={feedRef}>
        {messages.length === 0 && (
          <Typography variant="body-sm" color="subtle" className={styles.empty}>
            {placeholder ?? t('assistant.placeholder')}
          </Typography>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            // Метки для QA-прогона: чья реплика и какие поля изменил ответ.
            data-assistant-message={message.role}
            className={[
              styles.message,
              message.role === 'user' ? styles.user : styles.assistant,
            ].join(' ')}
          >
            <Typography variant="body-sm" color={message.role === 'user' ? 'inverse' : 'default'}>
              {message.text}
            </Typography>
            {message.images && <SentImageNames names={message.images} inverse />}

            {message.changedFields && message.changedFields.length > 0 && (
              <div className={styles.changed} data-assistant-changed>
                {message.changedFields.map((field) => (
                  <Badge key={field} tone="success">
                    {field}
                  </Badge>
                ))}
              </div>
            )}
            {message.missed && <AssistantMissed missed={message.missed} />}
          </div>
        ))}

        {ask.isPending && (
          <div className={styles.thinking}>
            <span className={styles.dots}>
              <span className={styles.dotPulse} />
              <span className={styles.dotPulse} />
              <span className={styles.dotPulse} />
            </span>
            <Typography variant="body-sm" color="muted" as="span">
              {t('assistant.thinking')}
            </Typography>
          </div>
        )}
      </div>

      {/* Режим записи: вместо поля ввода — живая дорожка голоса и две кнопки.
          Так видно, что микрофон слышит, и можно отменить сказанное. */}
      {isVoiceMode ? (
        <div className={styles.voicePanel}>
          <VoiceWave levels={levels} active={speech.listening} />

          <Typography variant="body-sm" color="muted" className={styles.voiceText}>
            {speech.finalizing
              ? t('assistant.finalizing')
              : speech.partial || speech.transcript || t('assistant.speakNow')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)" justify="center">
            <Button
              variant="secondary"
              leftIcon={<Icon name="close" size={24} />}
              onClick={cancelVoice}
              disabled={speech.finalizing}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Icon name="check" size={24} />}
              onClick={() => speech.stop()}
              disabled={speech.finalizing}
              isLoading={speech.finalizing}
            >
              {t('assistant.applyVoice')}
            </Button>
          </Stack>
        </div>
      ) : (
        <>
          {speechErrorKey && (
            <Typography variant="caption" color="danger" className={styles.speechError}>
              {t(speechErrorKey)}
            </Typography>
          )}

          <ImageAttachTray attach={attach} className={styles.attachTray} />
          <ImageAttachZone attach={attach} className={styles.composer}>
            <textarea
              className={styles.input}
              // Метка для QA-прогона: по ней проверяется, что помощник есть в форме.
              data-assistant-input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter отправляет, Shift+Enter переносит строку.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={t('assistant.inputPlaceholder')}
              rows={4}
              aria-label={t('assistant.title')}
            />

            <div className={styles.composerActions}>
              <ImageAttachButton attach={attach} />
              {speech.supported && (
                <Button
                  variant="secondary"
                  size="md"
                  iconOnly
                  icon={<Icon name="mic" size={24} />}
                  aria-label={t('assistant.startVoice')}
                  onClick={() => speech.start()}
                  disabled={ask.isPending}
                />
              )}

              <Button
                variant="primary"
                size="md"
                iconOnly
                icon={<Icon name="send" size={24} />}
                aria-label={t('assistant.send')}
                onClick={send}
                disabled={!input.trim() || ask.isPending || attach.isPreparing}
                isLoading={ask.isPending}
              />
            </div>
          </ImageAttachZone>
        </>
      )}
    </div>
  );
}

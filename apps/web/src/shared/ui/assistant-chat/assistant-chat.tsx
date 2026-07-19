import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { useSpeechRecognition } from '@shared/hooks/use-speech-recognition';
import { useMicLevels } from '@shared/hooks/use-mic-levels';
import { VoiceWave } from '@shared/ui/voice-wave';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import styles from './assistant-chat.module.scss';
import type { AssistantChatProps, AssistantMessage } from './assistant-chat.types';

interface AssistResponse {
  reply: string;
  fields: Record<string, unknown>;
  sessionId?: string;
  error?: string;
}

/**
 * Чат-помощник рядом с формой. Работает через сам Claude Code по вашей
 * подписке, поэтому отдельных ключей не требует. Ответ приходит структурой
 * «пояснение + значения полей», и поля применяются к форме сразу.
 *
 * Переписка живёт только пока открыто окно: помощник нужен для одного
 * заполнения, а не для длинной истории.
 */
export function AssistantChat({ kind, fields, schema, onApply, placeholder }: AssistantChatProps) {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  const feedRef = useRef<HTMLDivElement>(null);
  const speech = useSpeechRecognition(i18n.language === 'en' ? 'en-US' : 'ru-RU');

  // Панель записи показывается и во время финализации: пока речь переводится
  // в текст, кнопки заблокированы, но пользователь видит, что идёт обработка.
  const isVoiceMode = speech.listening || speech.finalizing;
  const levels = useMicLevels(speech.listening);

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
    mutationFn: async (message: string) => {
      const { data } = await apiClient.post<AssistResponse>(
        '/assist',
        { kind, message, fields, schema, sessionId },
        { timeout: 200_000 },
      );
      return data;
    },
    onSuccess: (data) => {
      setSessionId(data.sessionId);

      const changed = Object.keys(data.fields);
      if (changed.length > 0) onApply(data.fields);

      setMessages((current) => [
        ...current,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: data.error ? t('assistant.failed') : data.reply || t('assistant.noReply'),
          changedFields: changed,
        },
      ]);
    },
  });

  const send = (): void => {
    const text = input.trim();
    if (!text || ask.isPending) return;

    setMessages((current) => [...current, { id: `u-${Date.now()}`, role: 'user', text }]);
    setInput('');
    speech.reset();
    ask.mutate(text);
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
            className={[
              styles.message,
              message.role === 'user' ? styles.user : styles.assistant,
            ].join(' ')}
          >
            <Typography variant="body-sm" color={message.role === 'user' ? 'inverse' : 'default'}>
              {message.text}
            </Typography>

            {message.changedFields && message.changedFields.length > 0 && (
              <div className={styles.changed}>
                {message.changedFields.map((field) => (
                  <Badge key={field} tone="success">
                    {field}
                  </Badge>
                ))}
              </div>
            )}
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
        <div className={styles.composer}>
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
              disabled={!input.trim() || ask.isPending}
              isLoading={ask.isPending}
            />
          </div>
        </div>
      )}
    </div>
  );
}

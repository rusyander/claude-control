import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeechRecognition } from '@shared/hooks/use-speech-recognition';
import { useMicLevels } from '@shared/hooks/use-mic-levels';
import { VoiceWave } from '@shared/ui/voice-wave';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { AttachedFile, ChatComposerProps } from './ChatComposer.types';
import styles from './ChatComposer.module.scss';

/** Больше этого размера файл не приложить: он поедет в теле запроса. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Поле ввода чата: текст, надиктовка голосом и вложения. Пока идёт ответ,
 * отправка сменяется остановкой — прервать долгий разговор нужно уметь
 * в любой момент, а не ждать его конца.
 */
export function ChatComposer({ value, onChange, onSend, onStop, isRunning }: ChatComposerProps) {
  const { t, i18n } = useTranslation();
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const speech = useSpeechRecognition(i18n.language === 'en' ? 'en-US' : 'ru-RU');
  const levels = useMicLevels(speech.listening);
  const isVoiceMode = speech.listening || speech.finalizing;

  // Надиктованное дописываем к тексту, а не заменяем: часть могла быть набрана
  // руками до того, как пользователь взялся за микрофон. Текущий текст и колбэки
  // держим в ref: попади они в зависимости — эффект срабатывал бы на каждой
  // набранной букве и дописывал распознанное повторно.
  const latest = useRef({ value, onChange, reset: speech.reset });
  latest.current = { value, onChange, reset: speech.reset };

  const transcript = speech.transcript;
  useEffect(() => {
    if (!transcript) return;
    const { value: text, onChange: emit, reset } = latest.current;
    emit(text ? `${text} ${transcript}` : transcript);
    reset();
  }, [transcript]);

  // Поле растёт под текст, пока не упрётся в предел из стилей.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [value]);

  const attach = async (list: FileList | null): Promise<void> => {
    if (!list) return;

    const attached = await Promise.all(
      [...list].filter((file) => file.size <= MAX_FILE_BYTES).map(toAttachedFile),
    );
    setFiles((current) => [...current, ...attached]);
  };

  const submit = (): void => {
    if (!value.trim() || isRunning) return;
    onSend(files);
    setFiles([]);
  };

  if (isVoiceMode) {
    return (
      <div className={styles.composer}>
        <div className={styles.box}>
          <Stack
            direction="row"
            align="center"
            gap="var(--spacing-sm)"
            padding="var(--spacing-sm) var(--spacing-md)"
          >
            <VoiceWave levels={levels} active={speech.listening} className={styles.wave} />

            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="secondary"
                leftIcon={<Icon name="close" size={24} />}
                onClick={() => {
                  speech.stop();
                  speech.reset();
                }}
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
          </Stack>

          <Typography variant="body-sm" color="muted" className={styles.hint}>
            {speech.finalizing
              ? t('assistant.finalizing')
              : speech.partial || t('assistant.speakNow')}
          </Typography>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.composer}>
      <div
        className={`${styles.box} ${isDragging ? styles.boxDragging : ''}`}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          setIsDragging(false);
          void attach(event.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <Stack
            direction="row"
            wrap
            gap="var(--spacing-2xs)"
            padding="var(--spacing-xs) var(--spacing-md) 0"
          >
            {files.map((file) => (
              <Stack
                as="span"
                key={file.name}
                direction="row"
                align="center"
                gap="var(--spacing-3xs)"
                className={styles.file}
              >
                <Icon name="file" size={14} />
                {file.name}
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="close" size={14} />}
                  aria-label={`${t('common.delete')}: ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((item) => item !== file))}
                />
              </Stack>
            ))}
          </Stack>
        )}

        <textarea
          ref={inputRef}
          className={styles.input}
          data-chat-input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter отправляет, Shift+Enter переносит строку.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t('chat.placeholder')}
          rows={3}
        />

        <Stack
          direction="row"
          align="center"
          justify="between"
          gap="var(--spacing-xs)"
          padding="var(--spacing-2xs) var(--spacing-xs) var(--spacing-xs)"
        >
          <Stack direction="row" align="center" gap="var(--spacing-3xs)">
            <Button
              variant="ghost"
              iconOnly
              icon={<Icon name="paperclip" size={24} />}
              aria-label={t('chat.attach')}
              onClick={() => fileRef.current?.click()}
            />
            <Button
              variant="ghost"
              iconOnly
              icon={<Icon name="mic" size={24} />}
              aria-label={t('assistant.voiceInput')}
              onClick={() => speech.start()}
              disabled={!speech.supported}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              className={styles.hiddenInput}
              accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.md,.txt,.json,.csv,.yml,.yaml,.html,.css,.js,.ts,.tsx,.py"
              onChange={(event: ChangeEvent<HTMLInputElement>) => void attach(event.target.files)}
            />
          </Stack>

          {isRunning ? (
            <Button variant="secondary" leftIcon={<Icon name="stop" size={20} />} onClick={onStop}>
              {t('chat.stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              iconOnly
              icon={<Icon name="send" size={24} />}
              aria-label={t('chat.send')}
              onClick={submit}
              disabled={!value.trim()}
            />
          )}
        </Stack>
      </div>

      <Typography variant="caption" color="subtle" className={styles.hint}>
        {t('chat.hint')}
      </Typography>
    </div>
  );
}

async function toAttachedFile(file: File): Promise<AttachedFile> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // btoa не принимает большие строки целиком — собираем порциями.
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }

  return { name: file.name, sizeBytes: file.size, base64: btoa(binary) };
}

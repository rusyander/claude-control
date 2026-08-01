import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeechRecognition } from '@shared/hooks/use-speech-recognition';
import { useMicLevels } from '@shared/hooks/use-mic-levels';
import { speechErrorMessageKey } from '@shared/lib/speech';
import { VoiceWave } from '@shared/ui/voice-wave';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@claude-control/contracts/uploads';
import { planAttach, toAttachedFile } from '../lib/attachments';
import type { AttachedFile, ChatComposerProps } from './ChatComposer.types';
import styles from './ChatComposer.module.scss';

/**
 * Поле ввода чата: текст, надиктовка голосом и вложения. Пока идёт ответ,
 * отправка сменяется остановкой — прервать долгий разговор нужно уметь
 * в любой момент, а не ждать его конца.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  onRejectFiles,
  isRunning,
}: ChatComposerProps) {
  const { t, i18n } = useTranslation();
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const speech = useSpeechRecognition(i18n.language === 'en' ? 'en-US' : 'ru-RU');
  const levels = useMicLevels(speech.listening);
  const isVoiceMode = speech.listening || speech.finalizing;
  // null — либо ошибок не было, либо это тишина/отмена: о них не говорят.
  const speechErrorKey = speechErrorMessageKey(speech.error);

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

    // Слишком большой файл раньше отсеивался молча: чип не появлялся, сообщения
    // не было — отличить это от сломанного перетаскивания было нельзя. Отказ
    // уходит тем же путём, что и отказ по типу файла: сообщением от страницы.
    const plan = planAttach([...list]);
    if (plan.rejected.length > 0) onRejectFiles?.(plan.rejected);
    if (plan.accepted.length === 0) return;

    const attached = await Promise.all(plan.accepted.map(toAttachedFile));
    setFiles((current) => [...current, ...attached]);
  };

  const submit = (): void => {
    if (!value.trim()) return;
    // Чипы снимаем, только когда отправку приняли. Сообщение может быть
    // отклонено (неподдерживаемый тип файла, занятый прогон), и раньше в этом
    // случае вложения пропадали вместе с текстом — приложить их приходилось
    // заново, хотя человек ничего не отменял.
    void Promise.resolve(onSend(files)).then((accepted) => {
      if (accepted !== false) setFiles([]);
    });
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
              aria-label={t('assistant.startVoice')}
              onClick={() => speech.start()}
              disabled={!speech.supported}
            />
            {/* accept берётся из общего списка расширений: своя строка здесь
                расходилась бы с проверками фронта и сервера молча — диалог не
                показывал бы файл, который панель на самом деле принимает. */}
            <input
              ref={fileRef}
              type="file"
              multiple
              className={styles.hiddenInput}
              accept={UPLOAD_ACCEPT_ATTRIBUTE}
              onChange={(event: ChangeEvent<HTMLInputElement>) => void attach(event.target.files)}
            />
          </Stack>

          {/* Пока агент занят, рядом с остановкой остаётся и отправка: дописанное
              встанет в очередь и уйдёт на границе хода. Раньше кнопка тут просто
              исчезала — сказать агенту хоть слово можно было, только убив его. */}
          <Stack direction="row" align="center" gap="var(--spacing-2xs)">
            {isRunning && (
              <Button
                variant="secondary"
                leftIcon={<Icon name="stop" size={20} />}
                onClick={onStop}
              >
                {t('chat.stop')}
              </Button>
            )}
            <Button
              variant="primary"
              iconOnly
              icon={<Icon name="send" size={24} />}
              aria-label={isRunning ? t('chat.queue.add') : t('chat.send')}
              title={isRunning ? t('chat.queue.hint') : undefined}
              onClick={submit}
              disabled={!value.trim()}
            />
          </Stack>
        </Stack>
      </div>

      {/* Голосовой режим при ошибке (нет доступа к микрофону, нет сети) просто
          закрывался, и человек жал микрофон снова. Пока причина не устарела,
          она стоит вместо подсказки: место одно, а сказать важнее. */}
      <Typography
        variant="caption"
        color={speechErrorKey ? 'danger' : 'subtle'}
        className={styles.hint}
      >
        {speechErrorKey ? t(speechErrorKey) : t('chat.hint')}
      </Typography>
    </div>
  );
}

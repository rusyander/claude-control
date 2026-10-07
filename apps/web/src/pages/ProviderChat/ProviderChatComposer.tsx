import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ChatModeMenu } from '@features/ChatComposer';
import {
  ImageAttachButton,
  ImageAttachTray,
  ImageAttachZone,
  useImageAttach,
} from '@shared/ui/image-attach';
import type { ProviderChatComposerProps } from './ProviderChatComposer.types';
import styles from './ProviderChatPage.module.scss';

/** Поле ввода: Enter отправляет, Shift+Enter переносит строку — как в чате Claude. */
export function ProviderChatComposer({
  attachments,
  onAttach,
  onClearAttachments,
  onSend,
  isRunning,
  isSteerable,
  isBlocked,
  modes,
}: ProviderChatComposerProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');

  // Неттекстовый режим: в поле описывают, а кнопка называется своим действием.
  // Вложения в нём не участвуют — просьба состоит из одного описания.
  const isImage = modes?.mode === 'image';
  const isDeck = modes?.mode === 'deck';
  const isMedia = isImage || isDeck;
  const isDrawing = Boolean(modes?.isDrawing);
  // Картинки — тем же общим вложением, что у всех полей агента; в неттекстовом
  // режиме вложения не участвуют, как и файлы.
  const attach = useImageAttach({ disabled: Boolean(isBlocked) || isMedia });

  // Отправка идёт, пока картинки кладутся к панели: `isRunning` встаёт только
  // после этого, и второй Enter за это время отправлял то же сообщение ещё раз
  // (ревью 28.09 F-92). Ref — для второго нажатия до перерисовки, состояние — для
  // кнопки.
  const sendingRef = useRef(false);
  const [isSending, setIsSending] = useState(false);

  // Пока идёт ответ, обычное сообщение встаёт в очередь сервера и уйдёт само
  // по его концу; картинку и презентацию панель собирает отдельным ходом — им
  // ждать.
  const isHeld = isRunning && isMedia;

  const submit = (): void => {
    const text = input.trim();
    if (!text || sendingRef.current || isHeld || isBlocked || isDrawing || attach.isPreparing) {
      return;
    }
    sendingRef.current = true;
    setIsSending(true);
    const sentInput = input;
    const sentIds = isMedia ? [] : attach.items.map((item) => item.id);
    // Поле чистим только после «да»: отказ (занятый прогон, недоступный маршрут)
    // иначе стирал бы набранное описание. Убирается ровно ушедшее: набранное и
    // приложенное за время отправки — уже следующее сообщение.
    void Promise.resolve(onSend(text, isMedia ? [] : attach.images))
      .then((accepted) => {
        if (accepted === false) return;
        setInput((current) =>
          current.startsWith(sentInput) ? current.slice(sentInput.length).trimStart() : current,
        );
        for (const id of sentIds) attach.remove(id);
      })
      .finally(() => {
        sendingRef.current = false;
        setIsSending(false);
      });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter во время набора через IME лишь подтверждает кандидата — по нему
    // не отправляем, иначе уходит половина слова.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // Подписи считаем заранее: вложенные тернарники в разметке запрещены, и не зря.
  const placeholder = ((): string => {
    // На дороге агента рисует ОН: «панель нарисует сама, без агента» здесь было
    // бы прямой неправдой, а читают именно эту строку.
    if (isImage && modes?.imageByAgent) return t('chat.mode.imagePlaceholderAgent');
    if (isImage) return t('chat.mode.imagePlaceholder');
    // В правке описывают ПРАВКУ: «назовите тему» здесь читалось бы как
    // предложение собрать новую колоду вместо этой.
    if (isDeck && modes?.reviseTitle) return t('chat.mode.revisePlaceholder');
    if (isDeck) return t('chat.mode.deckPlaceholder');
    // Ход принимает сообщения посреди ответа (В1) — обещать «по концу» неправда.
    if (isRunning && isSteerable) return t('providerChat.steerPlaceholder');
    if (isRunning) return t('providerChat.queuePlaceholder');
    return t('providerChat.placeholder');
  })();
  const sendLabel = ((): string => {
    if (isImage) return t('chat.mode.draw');
    if (isDeck) return t('chat.mode.build');
    if (isRunning && isSteerable) return t('providerChat.steerSend');
    if (isRunning) return t('providerChat.queueSend');
    return t('providerChat.send');
  })();

  return (
    <>
      {attachments.length > 0 && !isMedia && (
        <Stack
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          wrap
          className={styles.attachments}
        >
          <Typography variant="caption" color="subtle">
            {t('providerChat.attached', { count: attachments.length })}
          </Typography>
          <Button size="sm" variant="ghost" onClick={onClearAttachments}>
            {t('providerChat.clearAttachments')}
          </Button>
        </Stack>
      )}

      {modes && (
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <ChatModeMenu state={modes} disabled={isRunning || isBlocked || isDrawing} />
          {/* Чем сделает или что мешает — строкой рядом, как у Claude: причина
              недоступности на телефоне иначе живёт только в подсказке мыши. */}
          {isMedia && (
            <Typography variant="caption" color={modeCaptionColor(modes)} as="span">
              {modeCaption(modes, t)}
            </Typography>
          )}
          {/* Что правит следующая отправка — на виду, с отменой рядом: «поправь
              третий слайд» без названия колоды легко отправить не в ту. */}
          {isDeck && modes.reviseTitle && (
            <Stack
              as="span"
              direction="row"
              align="center"
              gap="var(--spacing-3xs)"
              className={styles.revise}
            >
              <Icon name="edit" size={14} />
              {t('chat.mode.reviseTitle', { title: modes.reviseTitle })}
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Icon name="close" size={14} />}
                aria-label={t('chat.mode.reviseCancel')}
                onClick={() => modes.onReviseCancel?.()}
              />
            </Stack>
          )}
        </Stack>
      )}

      {!isMedia && <ImageAttachTray attach={attach} />}
      <ImageAttachZone attach={attach} className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={2}
          disabled={isBlocked}
        />
        {/* Очистить поле одним нажатием — как в чате Claude. Кнопки нет, пока
            стирать нечего: иначе она занимала бы место рядом с отправкой зря. */}
        {input.length > 0 && (
          <Button
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={18} />}
            aria-label={t('chat.clearInput')}
            title={t('chat.clearInput')}
            onClick={() => setInput('')}
          />
        )}
        <Button
          variant="ghost"
          iconOnly
          icon={<Icon name="paperclip" size={18} />}
          aria-label={t('providerChat.attach')}
          onClick={onAttach}
          disabled={isBlocked || isMedia}
        />
        <ImageAttachButton attach={attach} />
        <Button
          variant="primary"
          onClick={submit}
          disabled={!input.trim() || isHeld || isBlocked || isDrawing || attach.isPreparing}
          isLoading={isDrawing || isSending}
          leftIcon={<Icon name={isMedia ? 'image' : 'send'} size={18} />}
        >
          {sendLabel}
        </Button>
      </ImageAttachZone>
    </>
  );
}

/** Что сказать под меню: причина сильнее подписи маршрута. */
function modeCaption(
  modes: NonNullable<ProviderChatComposerProps['modes']>,
  t: (key: string) => string,
): string {
  if (modes.mode === 'image') {
    if (!modes.imageAvailable) return modes.imageReason ?? t('chat.mode.imageBlocked');
    return modes.imageSource ?? t('chat.mode.imageHint');
  }
  if (!modes.deckAvailable) return modes.deckReason ?? t('chat.mode.deckBlocked');
  return modes.deckSource ?? t('chat.mode.deckHint');
}

function modeCaptionColor(
  modes: NonNullable<ProviderChatComposerProps['modes']>,
): 'danger' | 'subtle' {
  const available = modes.mode === 'image' ? modes.imageAvailable : modes.deckAvailable;
  return available ? 'subtle' : 'danger';
}

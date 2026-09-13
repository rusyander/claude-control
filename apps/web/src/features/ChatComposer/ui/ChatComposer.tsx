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
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@agentdeck/contracts/uploads';
import { planAttach, toAttachedFile } from '../lib/attachments';
import { ChatModeMenu } from './ChatModeMenu';
import type { AttachedFile, ChatComposerProps, ComposerMode } from './ChatComposer.types';
import styles from './ChatComposer.module.scss';

/** Значок кнопки отправки по режиму: действие видно не читая подписи. */
const SEND_ICON: Record<ComposerMode, 'send' | 'image' | 'overview'> = {
  text: 'send',
  image: 'image',
  deck: 'overview',
};

/** Подсказка в пустом поле: в неттекстовом режиме там описывают, а не пишут. */
const MEDIA_PLACEHOLDER: Partial<Record<ComposerMode, string>> = {
  image: 'chat.mode.imagePlaceholder',
  deck: 'chat.mode.deckPlaceholder',
};

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
  onSplitTasks,
  onHandoff,
  modes,
}: ChatComposerProps) {
  const { t, i18n } = useTranslation();
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Режим картинки: вложения в нём не участвуют — просьба к контуру состоит из
  // одного описания. Поэтому чипы и скрепка в нём не показываются, но и не
  // стираются: человек ничего не отменял, и при возврате в текст файлы на месте.
  const isImage = modes?.mode === 'image';
  const isDeck = modes?.mode === 'deck';
  // Оба неттекстовых режима ведут себя одинаково: описание вместо сообщения,
  // вложения не участвуют, кнопка называется своим действием.
  const isMedia = isImage || isDeck;
  const isDrawing = Boolean(modes?.isDrawing);

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

  // Подписи отправки: три разных действия одной кнопкой — нарисовать, дописать
  // в очередь занятому агенту, отправить. Считаем заранее: вложенные тернарники
  // в разметке здесь запрещены, и не зря — читать их в JSX нельзя.
  const sendLabel = ((): string => {
    if (isImage) return t('chat.mode.draw');
    if (isDeck) return t('chat.mode.build');
    return isRunning ? t('chat.queue.add') : t('chat.send');
  })();
  // Подсказка пустого поля. У правки она своя: в этом режиме описывают ПРАВКУ, а
  // «назовите тему» здесь читалось бы как предложение собрать новую колоду.
  const placeholderKey = ((): string => {
    if (isDeck && modes?.reviseTitle) return 'chat.mode.revisePlaceholder';
    // «Панель нарисует сама, без агента» на дороге агента — прямая неправда, а
    // читают именно подсказку в поле, а не подпись маршрута под ним.
    if (isImage && modes?.imageByAgent) return 'chat.mode.imagePlaceholderAgent';
    return MEDIA_PLACEHOLDER[modes?.mode ?? 'text'] ?? 'chat.placeholder';
  })();

  const sendTitle = ((): string | undefined => {
    if (isMedia) return sendLabel;
    return isRunning ? t('chat.queue.hint') : undefined;
  })();

  // Нижняя строка: ошибка распознавания важнее всего, за ней — ход работы режима
  // и то, чем его сделают. Место одно, и занимает его самое срочное.
  const caption = ((): { text: string; isError: boolean } => {
    if (speechErrorKey) return { text: t(speechErrorKey), isError: true };
    if (isDrawing) return { text: t('chat.mode.drawing'), isError: false };
    if (isImage && !modes?.imageAvailable) {
      return { text: modes?.imageReason ?? t('chat.mode.imageBlocked'), isError: true };
    }
    if (isImage) return { text: modes?.imageSource ?? t('chat.mode.imageHint'), isError: false };
    if (isDeck && !modes?.deckAvailable) {
      return { text: modes?.deckReason ?? t('chat.mode.deckBlocked'), isError: true };
    }
    if (isDeck) return { text: modes?.deckSource ?? t('chat.mode.deckHint'), isError: false };
    return { text: t('chat.hint'), isError: false };
  })();

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
        {files.length > 0 && !isMedia && (
          <Stack
            direction="row"
            wrap
            gap="var(--spacing-2xs)"
            padding="var(--spacing-xs) var(--spacing-md) 0"
          >
            {files.map((file, index) => (
              <Stack
                as="span"
                // Одно имя у двух файлов из разных папок — обычное дело,
                // ключ по имени сливал бы их в один чип.
                key={`${index}:${file.name}`}
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

        {/* Правка готовой колоды: что именно правится — на виду. «Поправь третий
            слайд» без названия колоды легко отправить не в ту, а отмена стоит
            рядом: человек вправе вернуться к сборке по теме, ничего не набирая
            заново. */}
        {isDeck && modes?.reviseTitle && (
          <Stack
            direction="row"
            align="center"
            gap="var(--spacing-3xs)"
            padding="var(--spacing-xs) var(--spacing-md) 0"
          >
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
          </Stack>
        )}

        <textarea
          ref={inputRef}
          className={styles.input}
          data-chat-input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter во время набора через IME (японский, китайский, корейский)
            // лишь подтверждает кандидата — отправлять по нему нельзя, иначе
            // уходит половина слова.
            if (event.nativeEvent.isComposing) return;
            // Enter отправляет, Shift+Enter переносит строку.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t(placeholderKey)}
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
            {/* Режим стоит первым в ряду: он решает, что вообще сделает отправка,
                а остальные кнопки — как её собрать. */}
            {modes && <ChatModeMenu state={modes} disabled={isRunning || isDrawing} />}
            {!isMedia && (
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="paperclip" size={24} />}
                aria-label={t('chat.attach')}
                onClick={() => fileRef.current?.click()}
              />
            )}
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
            {/* Разделить задачи можно и задним числом: агент предлагает это сам
                только на трёх и более независимых задачах, а спросить вправе
                кто угодно и когда угодно. */}
            {onSplitTasks && (
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="branch" size={24} />}
                aria-label={t('chat.split.ask')}
                title={t('chat.split.ask')}
                onClick={onSplitTasks}
                disabled={isRunning || isDrawing}
              />
            )}
            {/* «Закрыть этап» — та же просьба, что агент иногда высказывает сам,
                только высказанная человеком. Дальше решает он же: панель покажет
                карточку и без его согласия контекст не сотрёт. */}
            {onHandoff && (
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="refresh" size={24} />}
                aria-label={t('chat.handoff.ask')}
                title={t('chat.handoff.ask')}
                onClick={onHandoff}
                disabled={isRunning || isDrawing}
              />
            )}
          </Stack>

          {/* Пока агент занят, рядом с остановкой остаётся и отправка: дописанное
              встанет в очередь и уйдёт на границе хода. Раньше кнопка тут просто
              исчезала — сказать агенту хоть слово можно было, только убив его. */}
          <Stack direction="row" align="center" gap="var(--spacing-2xs)">
            {/* Очистить поле одним нажатием. Появляется только когда есть что
                стирать: пустая кнопка рядом с отправкой сбивала бы прицел. Вместе
                с текстом уходит и черновик в localStorage — он живёт тем же
                значением, и «очистил, а после перезагрузки вернулось» было бы
                худшим ответом на это нажатие. */}
            {value.length > 0 && (
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="close" size={20} />}
                aria-label={t('chat.clearInput')}
                title={t('chat.clearInput')}
                onClick={() => {
                  onChange('');
                  inputRef.current?.focus();
                }}
              />
            )}
            {isRunning && (
              <Button
                variant="secondary"
                leftIcon={<Icon name="stop" size={20} />}
                onClick={onStop}
              >
                {t('chat.stop')}
              </Button>
            )}
            {/* В режиме картинки отправка — это ожидание на минуты, и очереди у
                неё нет: показываем её занятой, а не запертой без причины. */}
            <Button
              variant="primary"
              iconOnly
              icon={<Icon name={SEND_ICON[modes?.mode ?? 'text'] ?? 'send'} size={24} />}
              aria-label={sendLabel}
              title={sendTitle}
              onClick={submit}
              isLoading={isDrawing}
              disabled={!value.trim() || isDrawing}
            />
          </Stack>
        </Stack>
      </div>

      {/* Голосовой режим при ошибке (нет доступа к микрофону, нет сети) просто
          закрывался, и человек жал микрофон снова. Пока причина не устарела,
          она стоит вместо подсказки: место одно, а сказать важнее. */}
      <Typography
        variant="caption"
        color={caption.isError ? 'danger' : 'subtle'}
        className={styles.hint}
      >
        {caption.text}
      </Typography>
    </div>
  );
}

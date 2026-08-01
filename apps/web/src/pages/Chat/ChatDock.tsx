import { useTranslation } from 'react-i18next';
import { toast } from '@shared/lib/toast';
import { formatBytes } from '@shared/lib/format';
import { ChatComposer, MAX_FILE_BYTES } from '@features/ChatComposer';
import { ChatQueue } from '@features/ChatQueue';
import { ChatProgressSheet } from '@features/ChatProgress';
import type { ChatDockProps } from './ChatDock.types';

/**
 * Нижняя часть чата: прогресс агента, очередь дописанного и поле ввода. Всё
 * трое живут вместе, потому что читаются снизу вверх как одно «что сейчас
 * происходит и что уйдёт следующим».
 */
export function ChatDock({
  progress,
  isRunning,
  queued,
  onCancelQueued,
  value,
  onChange,
  onSend,
  onStop,
}: ChatDockProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* План агента и дерево субагентов — read-only, из транскрипта. */}
      <ChatProgressSheet progress={progress} isRunning={isRunning} />

      {/* Дописанное, пока агент занят: видно, что уйдёт следующим, и можно
          передумать до отправки. */}
      <ChatQueue items={queued} onCancel={onCancelQueued} />

      <ChatComposer
        value={value}
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
        // Отказ по размеру идёт тем же путём, что и отказ по типу файла:
        // одно сообщение из семейства notSent, а не второй механизм рядом.
        onRejectFiles={(names) =>
          toast.error(
            t('chat.notSent.tooLarge', {
              names: names.join(', '),
              limit: formatBytes(MAX_FILE_BYTES),
            }),
          )
        }
        isRunning={isRunning}
      />
    </>
  );
}

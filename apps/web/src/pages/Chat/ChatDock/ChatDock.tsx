import { useTranslation } from 'react-i18next';
import { toast } from '@shared/lib/toast';
import { formatBytesIn } from '@shared/lib/format';
import { ChatComposer, MAX_FILE_BYTES, type AttachRejection } from '@features/ChatComposer';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../lib/uploads';
import { ChatQueue } from '@features/ChatQueue';
import { ChatProgressSheet } from '@features/ChatProgress';
import type { ChatDockProps } from './ChatDock.types';

/**
 * Нижняя часть чата: прогресс агента, очередь дописанного и поле ввода. Всё
 * трое живут вместе, потому что читаются снизу вверх как одно «что сейчас
 * происходит и что уйдёт следующим».
 */
export function ChatDock({
  focusKey,
  progress,
  isRunning,
  awaiting,
  queued,
  onCancelQueued,
  value,
  onChange,
  onSend,
  onStop,
  onSplitTasks,
  onHandoff,
  modes,
}: ChatDockProps) {
  const { t, i18n } = useTranslation();

  // Отказ при вложении: по типу и по размеру — отдельными сообщениями, у них
  // разные причины и разный совет. Размер назван рядом с пределом: «больше
  // 20 МБ» без самого размера не сверить.
  const rejectFiles = ({ unsupported, tooLarge }: AttachRejection): void => {
    const size = (bytes: number): string =>
      formatBytesIn(
        bytes,
        {
          bytes: (count) => t('common.bytes', { count }),
          kilobytes: t('common.kilobytes'),
          megabytes: t('common.megabytes'),
        },
        i18n.language,
      );
    if (unsupported.length > 0) {
      toast.error(
        t('chat.notSent.unsupportedAttach', {
          names: unsupported.join(', '),
          supported: SUPPORTED_UPLOAD_EXTENSIONS.join(', '),
        }),
      );
    }
    if (tooLarge.length > 0) {
      toast.error(
        t('chat.notSent.tooLarge', {
          names: tooLarge.map((file) => `${file.name} — ${size(file.size)}`).join(', '),
          limit: size(MAX_FILE_BYTES),
        }),
      );
    }
  };

  return (
    <>
      {/* План агента и дерево субагентов — read-only, из транскрипта. */}
      <ChatProgressSheet
        progress={progress}
        isRunning={isRunning}
        {...(awaiting ? { awaiting } : {})}
      />

      {/* Дописанное, пока агент занят: видно, что уйдёт следующим, и можно
          передумать до отправки. */}
      <ChatQueue items={queued} onCancel={onCancelQueued} />

      <ChatComposer
        {...(focusKey ? { focusKey } : {})}
        value={value}
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
        // Отказ при вложении — из того же семейства notSent, что и отказ при
        // отправке, а не второй механизм рядом.
        onRejectFiles={rejectFiles}
        isRunning={isRunning}
        onSplitTasks={onSplitTasks}
        onHandoff={onHandoff}
        {...(modes ? { modes } : {})}
      />
    </>
  );
}

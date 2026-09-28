import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_IMAGE_ACCEPT } from '@agentdeck/contracts/agent-images';
import { cn } from '@shared/lib/cn';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type {
  ImageAttachButtonProps,
  ImageAttachTrayProps,
  ImageAttachZoneProps,
  SentImageNamesProps,
} from './image-attach.types';
import styles from './image-attach.module.scss';

/**
 * Кнопка «Приложить картинку» и скрытое поле выбора файла за ней. `accept` —
 * из общего списка типов, который проверяет и сервер: своя строка здесь
 * разошлась бы с ним молча.
 */
export function ImageAttachButton({ attach, size = 'md', className }: ImageAttachButtonProps) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        iconOnly
        icon={<Icon name="image" size={size === 'sm' ? 18 : 24} />}
        aria-label={t('attach.button')}
        title={`${t('attach.button')}. ${t('attach.hint')}`}
        onClick={attach.openPicker}
        disabled={attach.disabled}
        className={className}
        data-image-attach-button
      />
      <input
        ref={attach.inputRef}
        type="file"
        multiple
        accept={AGENT_IMAGE_ACCEPT}
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden
        data-image-attach-input
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.target.files ?? []);
          // Тот же файл второй раз подряд — снова событие: иначе после «убрать»
          // вернуть его кнопкой было бы нельзя.
          event.target.value = '';
          void attach.add(files);
        }}
      />
    </>
  );
}

/**
 * Приложенные картинки миниатюрами с кнопкой «убрать» и отказ последнего
 * вложения словами. Пусто и молча — ничего не рисует.
 */
export function ImageAttachTray({ attach, className }: ImageAttachTrayProps) {
  const { t } = useTranslation();
  const { items, refusal, isPreparing, isDragging } = attach;
  if (items.length === 0 && !refusal && !isPreparing && !isDragging) return null;

  return (
    <div className={cn(styles.tray, className)} data-image-attach-tray>
      {items.length > 0 && (
        <ul className={styles.list} aria-label={t('attach.list')}>
          {items.map((item) => (
            <li key={item.id} className={styles.chip} data-image-chip={item.name} title={item.name}>
              <img className={styles.thumb} src={item.previewUrl} alt="" />
              <span className={styles.name}>{item.name}</span>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Icon name="close" size={14} />}
                aria-label={t('attach.remove', { name: item.name })}
                onClick={() => attach.remove(item.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {isDragging && (
        <Typography variant="caption" color="accent" as="p">
          {t('attach.dropHint')}
        </Typography>
      )}
      {isPreparing && (
        <Typography variant="caption" color="muted" as="p" role="status">
          {t('attach.preparing')}
        </Typography>
      )}
      {refusal && (
        <Typography variant="caption" color="danger" as="p" role="alert" data-image-refusal>
          {refusal}
        </Typography>
      )}
    </div>
  );
}

/**
 * Поле, принимающее картинки перетаскиванием и вставкой. Рисуется вместо
 * обёртки поля ввода — со своим классом раскладки; при перетаскивании над ним
 * видна рамка, чтобы было ясно, что картинку здесь примут.
 */
export function ImageAttachZone({ attach, className, children, ...rest }: ImageAttachZoneProps) {
  return (
    <div
      {...rest}
      className={cn(className, styles.zone, attach.isDragging && styles.zoneActive)}
      onPasteCapture={attach.onPaste}
      {...attach.dropZone}
      data-image-attach-zone
    >
      {children}
    </div>
  );
}

/** Имена картинок, ушедших с репликой, — в ленте разговора. */
export function SentImageNames({ names, inverse = false }: SentImageNamesProps) {
  const { t } = useTranslation();
  if (names.length === 0) return null;
  return (
    <span
      className={cn(styles.sent, inverse && styles.sentInverse)}
      aria-label={t('attach.sent', { names: names.join(', ') })}
      data-sent-images
    >
      {names.map((name, index) => (
        <span key={`${index}:${name}`} className={styles.sentName}>
          <Icon name="image" size={14} />
          {name}
        </span>
      ))}
    </span>
  );
}

import type { ImageAttachZoneProps } from '../image-attach.types';
import { cn } from '@shared/lib/cn';
import styles from '../image-attach.module.scss';

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

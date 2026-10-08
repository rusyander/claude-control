import type { ImageAttachTrayProps } from '../image-attach.types';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import styles from '../image-attach.module.scss';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';

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

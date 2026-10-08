import type { SentImageNamesProps } from '../image-attach.types';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import styles from '../image-attach.module.scss';
import { Icon } from '@shared/ui/icon';

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

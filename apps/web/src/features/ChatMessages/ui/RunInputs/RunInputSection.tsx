import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { RunInputSectionProps } from './RunInputs.types';
import styles from './RunInputs.module.scss';

/** Раздел входа: подпись, длина и сам текст — целиком, без обрезки. */
export function RunInputSection({ label, text }: RunInputSectionProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <Typography variant="caption" as="span">
          {label}
        </Typography>
        <Typography variant="caption" color="subtle" as="span">
          {t('chat.cascade.hub.received.chars', { count: text.length })}
        </Typography>
      </div>
      <pre className={styles.text}>{text}</pre>
    </div>
  );
}

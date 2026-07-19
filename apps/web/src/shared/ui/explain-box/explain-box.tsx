import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import styles from './explain-box.module.scss';
import type { ExplainBoxProps } from './explain-box.types';

/**
 * Встроенная справка раздела. Сделана на <details>: разворачивание работает
 * без JavaScript и без состояния, а браузер сам обеспечивает доступность.
 */
export function ExplainBox({ title, text, defaultOpen = false }: ExplainBoxProps) {
  return (
    <details className={styles.root} open={defaultOpen}>
      <summary className={styles.summary}>
        <Icon name="help" size={24} />
        <Typography variant="body-sm" weight="medium" color="info" as="span">
          {title}
        </Typography>
        <Icon name="chevronRight" size={24} className={styles.chevron} />
      </summary>
      <Typography variant="body-sm" color="muted" className={styles.body}>
        {text}
      </Typography>
    </details>
  );
}

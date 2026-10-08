import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import styles from './Callout.module.scss';
import type { CalloutProps } from '../help-kit.types';
import { TONE_ICONS } from './Callout.constants';

/**
 * Тонкость, о которую спотыкаются. Такие вещи бесполезно писать абзацем
 * в общем тексте: их замечают, только когда они выделены и стоят отдельно.
 */
export function Callout({ tone = 'info', title, children }: CalloutProps) {
  return (
    <div className={`${styles.callout} ${styles[`callout-${tone}`]}`}>
      <Icon name={TONE_ICONS[tone]} size={24} className={styles.calloutIcon} />
      <Stack gap="var(--spacing-3xs)" minWidth={0}>
        <Typography variant="body-sm" weight="medium" as="span">
          {title}
        </Typography>
        {children && (
          <Typography variant="body-sm" color="muted" as="span" className={styles.calloutText}>
            {children}
          </Typography>
        )}
      </Stack>
    </div>
  );
}

import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon, type IconName } from '@shared/ui/icon';
import styles from './help-kit.module.scss';
import type { CalloutProps, CalloutTone } from './help-kit.types';

const TONE_ICONS: Record<CalloutTone, IconName> = {
  info: 'info',
  warning: 'warning',
  danger: 'error',
  success: 'check',
};

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

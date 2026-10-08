import { Typography } from '@shared/ui/typography';
import styles from './GuideStep.module.scss';
import type { GuideStepProps } from '../help-kit.types';

export function GuideStep({ title, text, children }: GuideStepProps) {
  return (
    <li className={styles.guideStep}>
      <Typography variant="body-sm" weight="medium" as="h3" className={styles.guideStepTitle}>
        {title}
      </Typography>
      {text && (
        <Typography variant="body-sm" color="muted" as="p" className={styles.guideStepText}>
          {text}
        </Typography>
      )}
      {children && <div className={styles.guideStepBody}>{children}</div>}
    </li>
  );
}

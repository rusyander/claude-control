import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import styles from './help-kit.module.scss';
import type { CapabilityGridProps } from './help-kit.types';

/**
 * «Что умеет» против «чего не умеет». Границы возможностей объясняют раздел
 * быстрее, чем перечисление функций: понятно не только что делать, но и куда
 * не стоит идти за результатом.
 */
export function CapabilityGrid({ canTitle, can, cantTitle, cant }: CapabilityGridProps) {
  return (
    <div className={styles.capabilities}>
      <div className={`${styles.capabilityColumn} ${styles.capabilityCan}`}>
        <Typography variant="body-sm" weight="medium" as="span" className={styles.capabilityTitle}>
          {canTitle}
        </Typography>
        <ul className={styles.capabilityList}>
          {can.map((item) => (
            <li key={item} className={styles.capabilityItem}>
              <Icon name="check" size={24} className={styles.capabilityIconCan} />
              <Typography variant="body-sm" color="muted" as="span">
                {item}
              </Typography>
            </li>
          ))}
        </ul>
      </div>

      <div className={`${styles.capabilityColumn} ${styles.capabilityCant}`}>
        <Typography variant="body-sm" weight="medium" as="span" className={styles.capabilityTitle}>
          {cantTitle}
        </Typography>
        <ul className={styles.capabilityList}>
          {cant.map((item) => (
            <li key={item} className={styles.capabilityItem}>
              <Icon name="close" size={24} className={styles.capabilityIconCant} />
              <Typography variant="body-sm" color="muted" as="span">
                {item}
              </Typography>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

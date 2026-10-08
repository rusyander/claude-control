import type { PageTabPanelProps } from '../page-tabs.types';
import { pageTabPanelDomId, pageTabDomId } from '@shared/lib/page-tab';
import styles from '../page-tabs.module.scss';
import { Typography } from '@shared/ui/typography';

/** Панель открытой вкладки: подпись «что здесь» и содержимое. */
export function PageTabPanel({ page, tab, hint, children }: PageTabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={pageTabPanelDomId(page, tab)}
      aria-labelledby={pageTabDomId(page, tab)}
      // Tab из полосы ведёт в панель, даже если в ней нечего нажимать
      // (сводка из одних чисел): иначе фокус улетал в body.
      tabIndex={0}
      className={styles.panel}
    >
      {hint && (
        <Typography variant="body-sm" color="subtle" className={styles.hint}>
          {hint}
        </Typography>
      )}
      {children}
    </div>
  );
}

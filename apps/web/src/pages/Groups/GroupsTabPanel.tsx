import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { groupsPanelDomId, groupsTabDomId } from './model/tabs';
import type { GroupsTabPanelProps } from './GroupsTabPanel.types';
import styles from './GroupsTabPanel.module.scss';

/**
 * Панель вкладки страницы групп: подписана своей вкладкой, сверху строка
 * «что здесь». Заголовка нет — его роль играет вкладка над панелью.
 */
export function GroupsTabPanel({ tab, hint, children }: GroupsTabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={groupsPanelDomId(tab)}
      aria-labelledby={groupsTabDomId(tab)}
      className={styles.panel}
    >
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body-sm" color="subtle" className={styles.hint}>
          {hint}
        </Typography>
        {children}
      </Stack>
    </div>
  );
}

import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { EmptyStateProps } from './empty-state.types';
import styles from './empty-state.module.scss';

/**
 * Пустое состояние раздела. Одинокое слово «Пусто» посреди экрана читается
 * как недогруженная страница; вместо этого — значок, объяснение, что здесь
 * появится, и подсказка, с чего начать.
 */
export function EmptyState({ icon, title, text, action }: EmptyStateProps) {
  return (
    <Stack align="center" gap="var(--spacing-sm)" className={styles.root}>
      <div className={styles.icon}>
        <Icon name={icon} size={28} />
      </div>

      <Typography variant="heading-sm">{title}</Typography>

      {text && (
        <Typography color="muted" className={styles.text}>
          {text}
        </Typography>
      )}

      {action}
    </Stack>
  );
}

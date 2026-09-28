import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './PluginsPage.module.scss';
import type { CommandOutcomeProps } from './CommandOutcome.types';

/**
 * Итог команды CLI над плагином: вывод неудачной команды как есть (единственный
 * источник правды о том, что пошло не так) или «нужен перезапуск» после удачной.
 * Стоит на той вкладке, где команду дали (ревью 28.09, F-249).
 */
export function CommandOutcome({ result }: CommandOutcomeProps) {
  const { t } = useTranslation();
  if (!result) return null;
  if (!result.ok) {
    return (
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" color="danger">
          {t('plugins.commandFailed')}
        </Typography>
        <Typography variant="mono" color="muted" className={styles.output}>
          {result.output}
        </Typography>
      </Stack>
    );
  }
  return (
    <Typography variant="caption" color="success">
      {t('common.needsRestart')}
    </Typography>
  );
}

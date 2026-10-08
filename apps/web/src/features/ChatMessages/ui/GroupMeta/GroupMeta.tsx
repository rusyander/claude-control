import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { formatDuration } from '@shared/lib/format-duration';
import type { ChildStageGroup } from '../ChildStages.types';
import styles from './GroupMeta.module.scss';

/**
 * Колонки группы: модель с глубиной, время до первой правки, время работы.
 * Одной строкой через «·» они резались многоточием (живой прогон 29.09), и
 * глубины не было вовсе — а по ней видно, на чём идёт группа. Колонки
 * переносятся целиком, а не по буквам: на узком экране встают друг под друга.
 */
export function GroupMeta({ group }: { group: ChildStageGroup }) {
  const { t } = useTranslation();
  const cells: { key: string; label: string; value: string }[] = [];
  if (group.model) {
    const effort = group.effort
      ? t(`chat.effort_${group.effort}`, { defaultValue: group.effort })
      : '';
    cells.push({
      key: 'model',
      label: t('chat.cascade.hub.meta.model'),
      value: effort ? `${group.model} · ${effort}` : group.model,
    });
  }
  if (group.firstEditAfterMs !== undefined) {
    cells.push({
      key: 'firstEdit',
      label: t('chat.cascade.hub.meta.firstEdit'),
      value: formatDuration(group.firstEditAfterMs, t),
    });
  }
  // Длительность, а не состояние (L23): состояние говорит точка слева.
  if (group.workMs !== undefined) {
    cells.push({
      key: 'workTime',
      label: t('chat.cascade.hub.meta.workTime'),
      value: formatDuration(group.workMs, t),
    });
  }
  if (cells.length === 0) return null;
  return (
    <dl className={styles.meta} data-hub-meta>
      {cells.map((cell) => (
        <div key={cell.key} className={styles.metaCell} data-hub-meta-cell={cell.key}>
          <Typography variant="caption" color="subtle" as="dt">
            {cell.label}
          </Typography>
          <Typography variant="caption" as="dd" className={styles.metaValue}>
            {cell.value}
          </Typography>
        </div>
      ))}
    </dl>
  );
}

import { useTranslation } from 'react-i18next';
import { formatDuration } from '@shared/lib/format-duration';
import { limitShareText } from '../../lib/limitShareText';
import type { ChildStageGroup } from '../ChildStages.types';
import { MetricList } from '../MetricList/MetricList';
import type { MetricItem } from '../MetricList/MetricList.types';

/**
 * Колонки группы: модель с глубиной, время до первой правки, время работы,
 * доля окон лимита подписки.
 * Одной строкой через «·» они резались многоточием (живой прогон 29.09), и
 * глубины не было вовсе — а по ней видно, на чём идёт группа. Колонки — те же,
 * что у чисел раздела «Токены» (`MetricList`): одна форма на всю карточку.
 */
export function GroupMeta({ group }: { group: ChildStageGroup }) {
  const { t, i18n } = useTranslation();
  const cells: MetricItem[] = [];
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
  // Рядом со временем работы: сколько окон подписки съела группа — то, во что
  // она обошлась, когда платят не деньгами, а окном лимита.
  const limit = limitShareText(group.limitShare, t, i18n.language);
  if (limit) {
    cells.push({ key: 'limitShare', label: t('chat.cascade.hub.meta.limitShare'), value: limit });
  }
  return <MetricList items={cells} attr="data-hub-meta" />;
}

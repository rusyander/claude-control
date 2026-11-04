import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import type { ChildStageGroup } from '../ChildStages.types';
import { stageTrack, type StageStep } from '../../lib/stageTrack';
import styles from './GroupText.module.scss';

/** Звено пути словами хаба: «работа ×3» у повторов подряд. */
function stageLabel(step: StageStep, t: TFunction): string {
  const name = t(`chat.cascade.stageFull.${step.stage}`);
  return step.count > 1
    ? `${name} ${t('chat.cascade.hub.stageRepeat', { count: step.count })}`
    : name;
}

/**
 * Шапка группы: название с фишками состояния (ждёт ответа, пауза) и под ним
 * путь звеньев — где группа сейчас. Делит верхний ряд карточки
 * с кнопками группы (владелец 22.10.2026): кнопки справа больше не сжимают
 * тело карточки до узкой колонки — оно идёт под этим рядом во всю ширину, а
 * две строки шапки уравновешивают два ряда кнопок. Живёт внутри растянутой
 * кнопки «открыть чат», поэтому только строчные элементы и без действий.
 */
export function GroupHead({ group }: { group: ChildStageGroup }) {
  const { t } = useTranslation();
  const track = stageTrack(group.stages);
  const current = track.at(-1);
  return (
    <span className={styles.head}>
      <span className={styles.titleLine}>
        <Typography variant="body" weight="semibold" as="span" truncate className={styles.title}>
          {group.title}
        </Typography>
        {/* Стоит не просто так, а ждёт — и чаще всего человека (Д3, Д16): эта
          фишка — первой после названия, её ищут глазами раньше прочих. */}
        {group.waitingFor && (
          <Typography
            variant="caption"
            weight="medium"
            as="span"
            className={cn(styles.chip, styles.chipAsk)}
            data-hub-waiting={group.waitingFor}
          >
            {t(`chat.cascade.hub.waitingFor.${group.waitingFor}`)}
          </Typography>
        )}
        {group.isPaused && (
          <Typography variant="caption" color="subtle" as="span" className={styles.chip}>
            {t('chat.cascade.tree.paused')}
          </Typography>
        )}
      </span>
      {/* Путь группы (владелец 22.10): пройденные звенья — тихо, повторы —
          счётом, текущее — своей фишкой, чтобы оно читалось первым, а не в
          конце строки. */}
      {current && (
        <span className={styles.stages} data-hub-stages>
          {track.slice(0, -1).map((item, index) => (
            <Typography key={index} variant="caption" color="subtle" as="span">
              {stageLabel(item, t)} ›
            </Typography>
          ))}
          <Typography
            variant="caption"
            weight="medium"
            as="span"
            className={cn(styles.stageNow, group.isRunning && styles.stageRunning)}
            data-hub-stage-current={current.stage}
          >
            {t(group.isRunning ? 'chat.cascade.hub.stageNow' : 'chat.cascade.hub.stageLast')}:{' '}
            {stageLabel(current, t)}
          </Typography>
        </span>
      )}
    </span>
  );
}

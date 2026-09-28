import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { countMembersByKind, projectName } from './model/tile';
import type { StepsPreviewProps, TileFactsProps } from './TileFacts.types';
import styles from './TileFacts.module.scss';

/**
 * Что группа делает и из чего состоит — на самой карточке, без открытия окна:
 * первые шаги словами, состав по видам («скилл 1 · хуков 17 · серверов 3»),
 * закреплённые числа и проекты, где она включается сама.
 */
export function TileFacts({
  steps,
  stepsFailed = false,
  moreSteps = 0,
  noStepsText,
  members,
  pinned = 0,
  projects = [],
}: TileFactsProps) {
  const { t } = useTranslation();
  const kinds = countMembersByKind(members);
  const composition =
    kinds.length > 0
      ? kinds
          .map((item) => t(`groupsPage.tile.kind.${item.kind}`, { count: item.count }))
          .join(' · ')
      : t('groupsPage.tile.noMembers');

  return (
    <>
      <StepsPreview steps={steps} failed={stepsFailed} more={moreSteps} emptyText={noStepsText} />
      <Typography variant="caption" color="muted" as="p" className={styles.line}>
        {composition}
      </Typography>
      {pinned > 0 && (
        <Typography variant="caption" color="muted" as="p" className={styles.line}>
          {t('groupsPage.tile.pinned', { count: pinned })}
        </Typography>
      )}
      {projects.length > 0 && (
        <Typography
          variant="caption"
          color="muted"
          as="p"
          className={styles.line}
          title={projects.join('\n')}
        >
          {t('groupsPage.tile.projects', { names: projects.map(projectName).join(', ') })}
        </Typography>
      )}
    </>
  );
}

function StepsPreview({ steps, failed, more, emptyText }: StepsPreviewProps) {
  const { t } = useTranslation();
  if (failed) {
    return (
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {t('groupsPage.tile.stepsFailed')}
      </Typography>
    );
  }
  if (!steps) {
    return (
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {t('groupsPage.tile.stepsReading')}
      </Typography>
    );
  }
  if (steps.length === 0) {
    return (
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {emptyText}
      </Typography>
    );
  }
  return (
    <div className={styles.steps}>
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {t('groupsPage.tile.stepsLabel')}
      </Typography>
      <ol className={styles.list}>
        {steps.map((title, index) => (
          <li key={`${index}-${title}`} className={styles.step}>
            {title}
          </li>
        ))}
      </ol>
      {more > 0 && (
        <Typography variant="caption" color="subtle" as="p" className={styles.line}>
          {t('groupsPage.tile.more', { count: more })}
        </Typography>
      )}
    </div>
  );
}

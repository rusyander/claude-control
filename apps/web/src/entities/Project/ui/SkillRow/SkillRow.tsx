import type { SkillRowProps } from '../ProjectLocalConfigView/ProjectLocalConfigView.types';
import { useTranslation } from 'react-i18next';
import styles from './SkillRow.module.scss';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';

/**
 * Строки набора «Из проекта». Ни одна не правит: у проектного набора нет ни
 * тумблеров, ни форм — файлы принадлежат гиту проекта, панель их показывает.
 */

/** Скилл проекта: имя, описание, число дополнительных файлов; выключенный помечен. */
export function SkillRow({ skill }: SkillRowProps) {
  const { t } = useTranslation();

  return (
    <li className={styles.row}>
      <Stack gap="var(--spacing-2xs)" minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {skill.name}
          </Typography>
          {skill.files.length > 0 && (
            <Badge tone="neutral">{t('projectLocal.files', { count: skill.files.length })}</Badge>
          )}
          {!skill.isEnabled && <Badge tone="neutral">{t('projectLocal.skillDisabled')}</Badge>}
        </Stack>
        {skill.description && (
          <Typography variant="body-sm" color="muted" clamp={2} className={styles.text}>
            {skill.description}
          </Typography>
        )}
      </Stack>
    </li>
  );
}

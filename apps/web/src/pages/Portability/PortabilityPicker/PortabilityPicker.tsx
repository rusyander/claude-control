import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './PortabilityPicker.module.scss';
import type { PortabilityPickerProps } from './PortabilityPicker.types';

/**
 * Выбор источника, цели и уровня — общий для вкладок раздела; под ним сводка
 * паспорта. Вынесен из страницы, чтобы та осталась сборкой вкладок.
 */
export function PortabilityPicker({
  providerId,
  onProvider,
  providerOptions,
  showTarget,
  target,
  onTarget,
  targetOptions,
  scope,
  onScope,
  project,
  onProject,
  projectOptions,
  levelReady,
  passport,
}: PortabilityPickerProps) {
  const { t } = useTranslation();

  /** Уровни — ровно два; третьего у канона нет. */
  const scopeOptions = [
    { value: 'global', label: t('portability.scopeGlobal') },
    { value: 'project', label: t('portability.scopeProject') },
  ];

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" gap="var(--spacing-sm)" align="end" className={styles.picker}>
          <SelectField
            label={t('portability.provider')}
            value={providerId}
            onChange={onProvider}
            options={providerOptions}
          />
          {showTarget && (
            <SelectField
              label={t('portability.target')}
              value={target}
              onChange={onTarget}
              options={targetOptions}
            />
          )}
          <SelectField
            label={t('portability.scope')}
            value={scope}
            onChange={(value) => onScope(value === 'project' ? 'project' : 'global')}
            options={scopeOptions}
          />
          {scope === 'project' && (
            <SelectField
              label={t('portability.project')}
              value={project}
              onChange={onProject}
              options={projectOptions}
            />
          )}
        </Stack>

        {/* Уровень проекта без проекта — не пустой экран молча: сказано, чего
            не хватает, иначе человек читает отсутствие паспорта как «в этом
            проекте ничего не настроено». */}
        {!levelReady && (
          <Typography variant="caption" color="muted">
            {t('portability.projectNeeded')}
          </Typography>
        )}

        {passport && (
          <Stack direction="row" gap="var(--spacing-xs)" className={styles.summary}>
            <Badge tone="accent">
              {t('portability.itemCount', { count: passport.items.length })}
            </Badge>
            {/* Цвет несёт только непрочитанное: пустой раздел — законная
                часть обычного дома, и красить из-за него весь паспорт значило
                бы приучить к предупреждению, которое ничего не значит. */}
            <Badge
              tone={
                passport.skipped.some((skip) => skip.reason !== 'empty') ? 'warning' : 'neutral'
              }
            >
              {t('portability.skipCount', { count: passport.skipped.length })}
            </Badge>
            {/* Корень паспорта — тот самый каталог, из которого всё прочитано;
                без него человек не знает, чью среду он видит. */}
            <Typography variant="caption" color="muted" className={styles.root}>
              {passport.root || t('portability.rootUnknown')}
            </Typography>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

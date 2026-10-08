import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { ProjectLocalConfigViewProps } from './ProjectLocalConfigView.types';
import styles from './ProjectLocalConfigView.module.scss';
import { Sections } from './Sections/Sections';

/**
 * Собственный набор проекта из его `.claude` — скиллы, хуки и правила, которые
 * Claude Code загружает поверх пользовательских. Только чтение: файлы
 * принадлежат гиту проекта, поэтому здесь нет ни тумблеров, ни кнопок правки.
 *
 * Один блок на два места: вкладка «Из проекта» на странице проектов и карточка
 * привязанной группы (`compact` — счётчики и раскрытие по кнопке). Без второго
 * группа с привязкой выглядела пустой, хотя агент в ней работает с правилами и
 * скиллами проекта.
 */
export function ProjectLocalConfigView({ config, compact = false }: ProjectLocalConfigViewProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  if (!config.exists) {
    if (compact) {
      return (
        <Typography variant="caption" color="subtle">
          {t('projectLocal.noDir')}
        </Typography>
      );
    }
    return (
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Icon name="info" size={18} />
          <Typography variant="body-sm" weight="medium" as="span">
            {t('projectLocal.noDir')}
          </Typography>
        </Stack>
        <Typography variant="body-sm" color="muted" className={styles.text}>
          {t('projectLocal.noDirText')}
        </Typography>
        <Typography variant="mono" color="subtle" as="span" truncate>
          {config.root}
        </Typography>
      </Stack>
    );
  }

  if (!compact) return <Sections config={config} />;

  return (
    <Stack gap="var(--spacing-xs)">
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
        <Badge tone="neutral">
          {t('projectLocal.countSkills', { count: config.skills.length })}
        </Badge>
        <Badge tone="neutral">{t('projectLocal.countHooks', { count: config.hooks.length })}</Badge>
        <Badge tone="neutral">{t('projectLocal.countRules', { count: config.rules.length })}</Badge>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={isOpen}
          rightIcon={
            <Icon
              name="chevronDown"
              size={16}
              className={isOpen ? styles.chevronOpen : styles.chevron}
            />
          }
          onClick={() => setIsOpen((value) => !value)}
        >
          {isOpen ? t('projectLocal.collapse') : t('projectLocal.expand')}
        </Button>
      </Stack>
      {isOpen && <Sections config={config} />}
    </Stack>
  );
}

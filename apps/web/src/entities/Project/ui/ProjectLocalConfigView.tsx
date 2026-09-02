import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectLocalConfig } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { HookRow, RuleRow, SkillRow } from './ProjectLocalRows';
import type {
  ProjectLocalConfigViewProps,
  ProjectLocalSectionProps,
} from './ProjectLocalConfigView.types';
import styles from './ProjectLocalConfigView.module.scss';

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

/** Три раздела подряд — общая часть полного и раскрытого компактного вида. */
function Sections({ config }: { config: ProjectLocalConfig }) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-md)">
      <Section
        title={t('projectLocal.skills')}
        count={config.skills.length}
        empty={t('projectLocal.emptySkills')}
      >
        {config.skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
      </Section>
      <Section
        title={t('projectLocal.hooks')}
        count={config.hooks.length}
        empty={t('projectLocal.emptyHooks')}
      >
        {config.hooks.map((hook) => (
          <HookRow key={hook.id} hook={hook} />
        ))}
      </Section>
      <Section
        title={t('projectLocal.rules')}
        count={config.rules.length}
        empty={t('projectLocal.emptyRules')}
      >
        {config.rules.map((rule) => (
          <RuleRow key={rule.path} rule={rule} />
        ))}
      </Section>
    </Stack>
  );
}

/** Заголовок раздела со счётчиком; пустой раздел — одной строкой вместо списка. */
function Section({ title, count, empty, children }: ProjectLocalSectionProps) {
  return (
    <Stack gap="var(--spacing-2xs)" as="section" aria-label={title}>
      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Typography variant="body-sm" weight="semibold" as="span">
          {title}
        </Typography>
        <Badge tone={count > 0 ? 'accent' : 'neutral'}>{count}</Badge>
      </Stack>
      {count === 0 ? (
        <Typography variant="caption" color="subtle">
          {empty}
        </Typography>
      ) : (
        <ul className={styles.list}>{children}</ul>
      )}
    </Stack>
  );
}

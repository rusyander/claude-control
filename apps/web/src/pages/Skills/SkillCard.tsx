import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { ResourceFileTree } from '@features/ResourceFiles';
import { formatBytes } from '@shared/lib/format';
import styles from './SkillsPage.module.scss';
import type { SkillCardProps } from './SkillCard.types';

/** Карточка скилла: имя, описание-триггер и переключатель доступности. */
export function SkillCard({ skill, onToggle, onEdit, onDelete, isDeleting }: SkillCardProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Скилл из одного SKILL.md раскрывать нечем — дерево нужно только тем,
  // у кого есть вложенные файлы.
  const hasFiles = skill.files.length > 0;

  return (
    <Card padding="md">
      <Stack direction="row" gap="var(--spacing-md)" align="start" width="100%">
        <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" weight="medium" as="span">
              {skill.name}
            </Typography>
            {!skill.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
            {hasFiles && (
              <button
                type="button"
                className={styles.filesToggle}
                onClick={() => setIsExpanded((expanded) => !expanded)}
                aria-expanded={isExpanded}
              >
                <Icon
                  name="chevronRight"
                  size={14}
                  className={`${styles.filesChevron} ${isExpanded ? styles.filesChevronOpen : ''}`}
                />
                {t('skills.files', { count: skill.files.length })}
              </button>
            )}
            <Typography variant="caption" color="subtle" as="span">
              {formatBytes(skill.sizeBytes)}
            </Typography>
          </Stack>

          <Typography variant="body-sm" color="muted" clamp={2} className={styles.description}>
            {skill.description}
          </Typography>

          {isExpanded && <ResourceFileTree kind="skill" id={skill.id} />}
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
          <SandboxButton
            kind="skill"
            title={skill.name}
            selection={{ skillIds: [skill.id] }}
            context={{ description: skill.description }}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="edit" size={24} />}
            aria-label={`${t('common.edit')}: ${skill.name}`}
            onClick={onEdit}
          />
          <DeleteButton
            entityName={skill.name}
            description={t('common.deleteSkill')}
            onDelete={onDelete}
            isPending={isDeleting}
          />
          <Toggle checked={skill.isEnabled} onCheckedChange={onToggle} aria-label={skill.name} />
        </Stack>
      </Stack>
    </Card>
  );
}

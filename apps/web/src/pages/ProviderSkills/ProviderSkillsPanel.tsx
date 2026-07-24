import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { DeleteButton } from '@features/EntityDelete';
import { useProviderSkills, useDeleteProviderSkill } from '@entities/ProviderSkills';
import { ProviderSkillEditor } from './ProviderSkillEditor';
import { ProviderSkillCreateForm } from './ProviderSkillCreateForm';
import { skillProblemKey } from './skillProblem';

/**
 * Скиллы CLI (OPENCODE-5) — общая начинка для глобального раздела и вкладки
 * проекта: отличается только `projectId`.
 *
 * ЧЕСТНО О МОДЕЛИ. Понятие то же, что у скиллов Claude: скилл — папка с файлом
 * `SKILL.md`, у которого в начале YAML-шапка. Но это скиллы ЧУЖОГО CLI, у них
 * свой каталог и свой набор полей шапки (обязательны `name` и `description`).
 * Раздел скиллов Claude — другая страница и другая модель, он не тронут.
 *
 * Панель редактирует `name`/`description` и тело; прочие поля шапки сохраняет.
 * Скилл с неразобранной шапкой доступен только на чтение.
 */
export function ProviderSkillsPanel({ projectId }: { projectId?: string }) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderSkills(scope);
  const remove = useDeleteProviderSkill(scope);

  const [openSkill, setOpenSkill] = useState<string | undefined>(undefined);

  if (isLoading || !data) return <SkeletonList rows={5} />;

  const { skills, ignored, readOnly, externalDirs } = data;

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerSkills.explainTitle')}
        text={t('providerSkills.explain', {
          provider: data.providerName,
          skillsDir: data.skillsDir,
        })}
      />

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerSkills.skillsDir')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.skillsDir}
          </Typography>
          {!data.dirExists && <Badge tone="neutral">{t('providerSkills.dirMissing')}</Badge>}
        </Stack>
      </Card>

      {/* Прочие каталоги, из которых CLI ТОЖЕ грузит скиллы (например, готовые
          скиллы Claude). Нейтральная справка; панель туда ничего не пишет. */}
      {externalDirs.length > 0 && (
        <Card padding="sm">
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="info" size={18} />
              <Typography variant="body-sm" color="muted">
                {t('providerSkills.externalTitle', { provider: data.providerName })}
              </Typography>
            </Stack>
            <Typography variant="caption" color="subtle">
              {t('providerSkills.externalExplain')}
            </Typography>
            {externalDirs.map((dir) => (
              <Stack key={dir.path} direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                <Typography variant="mono" color="subtle" as="span" truncate>
                  {dir.path}
                </Typography>
                {!dir.exists && <Badge tone="neutral">{t('providerSkills.externalMissing')}</Badge>}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerSkills.dirUnreadable', { path: data.skillsDir })}
            </Typography>
          </Stack>
        </Card>
      )}

      {skills.length > 0 && (
        <Card padding="none">
          <Stack>
            {skills.map((skill) => (
              <Stack key={skill.path} gap="var(--spacing-2xs)" padding="var(--spacing-sm)">
                <Stack
                  direction="row"
                  align="center"
                  justify="between"
                  gap="var(--spacing-sm)"
                  wrap
                >
                  <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                    <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                      <Typography variant="mono" weight="medium" as="span">
                        {skill.name}
                      </Typography>
                      {skill.nameMismatch && (
                        <Badge tone="warning">{t('providerSkills.badgeNameMismatch')}</Badge>
                      )}
                      {!skill.frontmatterOk && (
                        <Badge tone="warning">
                          {t(`providerSkills.badge.${skillProblemKey(skill.problem)}`)}
                        </Badge>
                      )}
                    </Stack>
                    {skill.description && (
                      <Typography variant="body-sm" color="muted">
                        {skill.description}
                      </Typography>
                    )}
                    <Typography variant="mono" color="subtle" as="span" truncate>
                      {skill.fullPath}
                    </Typography>
                  </Stack>

                  <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setOpenSkill(openSkill === skill.path ? undefined : skill.path)
                      }
                    >
                      {openSkill === skill.path
                        ? t('common.close')
                        : skill.frontmatterOk
                          ? t('providerSkills.edit')
                          : t('providerSkills.view')}
                    </Button>
                    <DeleteButton
                      entityName={skill.name}
                      description={t('providerSkills.deleteSkill')}
                      onDelete={() => {
                        remove.mutate(skill.path);
                        if (openSkill === skill.path) setOpenSkill(undefined);
                      }}
                      isPending={remove.isPending}
                    />
                  </Stack>
                </Stack>

                {openSkill === skill.path && (
                  <ProviderSkillEditor
                    path={skill.path}
                    projectId={projectId}
                    onClose={() => setOpenSkill(undefined)}
                  />
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {skills.length === 0 && !readOnly && (
        <Typography color="subtle">{t('providerSkills.empty')}</Typography>
      )}

      {ignored.length > 0 && (
        <Card padding="sm">
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="info" size={18} />
              <Typography variant="body-sm" color="muted">
                {t('providerSkills.ignoredTitle')}
              </Typography>
            </Stack>
            <Typography variant="caption" color="subtle">
              {t('providerSkills.ignoredExplain')}
            </Typography>
            {ignored.map((dir) => (
              <Typography key={dir.dirName} variant="mono" color="subtle" as="span" truncate>
                {dir.dirName}
              </Typography>
            ))}
          </Stack>
        </Card>
      )}

      {!readOnly && (
        <ProviderSkillCreateForm
          skillsDir={data.skillsDir}
          existing={skills.map((skill) => skill.dirName)}
          projectId={projectId}
          onCreated={setOpenSkill}
        />
      )}

      <Typography variant="caption" color="subtle">
        {t('common.needsRestart')}
      </Typography>
    </Stack>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderSkillDraft } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderSkill, useSaveProviderSkill } from '@entities/ProviderSkills';
import { skillProblemKey } from './skillProblem';
import styles from './ProviderSkillsPage.module.scss';

/**
 * Редактор ОДНОГО скилла `SKILL.md`: два задокументированных поля шапки
 * (`name`, `description`) — отдельными полями формы, markdown-тело — отдельной
 * областью. Имя скилла редактировать здесь нельзя: оно и есть имя папки, менять
 * его — значит переименовывать/пересоздавать скилл, поэтому оно только
 * показывается. Прочие ключи шапки (`license`, `compatibility`, `metadata`,
 * чужие) панель не трогает — при сохранении они остаются в файле.
 *
 * Скилл, чью шапку панель не разобрала, открывается ТОЛЬКО НА ЧТЕНИЕ: показываем
 * файл целиком и честно говорим, почему кнопки сохранения нет.
 */
export function ProviderSkillEditor({
  path,
  projectId,
  onClose,
}: {
  path: string;
  projectId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderSkill(path, scope);
  const save = useSaveProviderSkill(scope);

  const [draft, setDraft] = useState<ProviderSkillDraft | undefined>(undefined);

  // Переключились на другой скилл — берём содержимое заново.
  useEffect(() => {
    setDraft(undefined);
  }, [path]);

  useEffect(() => {
    if (data !== undefined && draft === undefined && !data.readOnly) {
      setDraft({
        path: data.path,
        name: data.name,
        description: data.description,
        body: data.body,
      });
    }
  }, [data, draft]);

  if (isLoading || !data) return <SkeletonList rows={4} withActions={false} />;

  // Шапка не разобрана — файл показываем как есть и не переписываем.
  if (data.readOnly) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t(`providerSkills.readOnly.${skillProblemKey(data.problem)}`)}
            </Typography>
          </Stack>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.fullPath}
          </Typography>
          <textarea
            className={styles.readOnlyEditor}
            value={data.body}
            readOnly
            spellCheck={false}
            aria-label={data.fullPath}
          />
          <Stack direction="row" justify="end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
          </Stack>
        </Stack>
      </Card>
    );
  }

  if (!draft) return <SkeletonList rows={4} withActions={false} />;

  const dirty = draft.body !== data.body || draft.description !== data.description;
  const descriptionEmpty = !draft.description.trim();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.fullPath}
          </Typography>
          {data.otherKeys.length > 0 && (
            <Badge tone="neutral">
              {t('providerSkills.otherKeys', { keys: data.otherKeys.join(', ') })}
            </Badge>
          )}
        </Stack>

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm">{t('providerSkills.fieldName')}</Typography>
          <Typography variant="mono" weight="medium" as="span">
            {data.name}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('providerSkills.nameLocked')}
          </Typography>
        </Stack>

        <TextField
          label={t('providerSkills.fieldDescription')}
          value={draft.description}
          onChange={(value) => setDraft({ ...draft, description: value })}
          hint={t('providerSkills.hintDescription')}
          placeholder={t('providerSkills.placeholderDescription')}
          error={descriptionEmpty ? t('providerSkills.descriptionRequired') : undefined}
        />

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm">{t('providerSkills.fieldBody')}</Typography>
          <textarea
            className={styles.editor}
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            spellCheck={false}
            aria-label={t('providerSkills.fieldBody')}
          />
        </Stack>

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="caption" color="subtle">
            {t('claudeMd.chars', { count: draft.body.length })}
            {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="check" size={18} />}
              onClick={() => save.mutate({ ...draft, path: data.path })}
              isLoading={save.isPending}
              disabled={!dirty || descriptionEmpty}
            >
              {t('common.save')}
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
}

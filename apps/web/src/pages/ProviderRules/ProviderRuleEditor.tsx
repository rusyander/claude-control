import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderRuleDraft } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderRule, useSaveProviderRule } from '@entities/ProviderRules';
import styles from './ProviderRulesPage.module.scss';

/**
 * Редактор ОДНОГО правила `.mdc`: три задокументированных поля frontmatter
 * (`description`, `globs`, `alwaysApply`) — отдельными полями формы, markdown-тело
 * — отдельной областью. Так пользователю не приходится помнить синтаксис
 * frontmatter, а тело при сохранении уходит на диск без изменений.
 *
 * Правило, чей frontmatter панель не разобрала, открывается ТОЛЬКО НА ЧТЕНИЕ:
 * показываем файл целиком и честно говорим, почему кнопки сохранения нет.
 */
export function ProviderRuleEditor({
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
  const { data, isLoading } = useProviderRule(path, scope);
  const save = useSaveProviderRule(scope);

  const [draft, setDraft] = useState<ProviderRuleDraft | undefined>(undefined);

  // Переключились на другое правило — берём содержимое заново.
  useEffect(() => {
    setDraft(undefined);
  }, [path]);

  useEffect(() => {
    if (data !== undefined && draft === undefined) {
      setDraft({
        path: data.path,
        description: data.description ?? '',
        globs: data.globs ?? '',
        alwaysApply: data.alwaysApply ?? false,
        body: data.body,
      });
    }
  }, [data, draft]);

  if (isLoading || !data) return <SkeletonList rows={4} withActions={false} />;

  // Frontmatter не разобран — файл показываем как есть и не переписываем.
  if (data.readOnly) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t(
                data.problem === 'no_frontmatter'
                  ? 'providerRules.readOnlyNoFrontmatter'
                  : 'providerRules.readOnlyMalformed',
              )}
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
              {t('providerRules.close')}
            </Button>
          </Stack>
        </Stack>
      </Card>
    );
  }

  if (!draft) return <SkeletonList rows={4} withActions={false} />;

  const dirty =
    draft.body !== data.body ||
    (draft.description ?? '') !== (data.description ?? '') ||
    (draft.globs ?? '') !== (data.globs ?? '') ||
    (draft.alwaysApply ?? false) !== (data.alwaysApply ?? false);

  const patch = (next: Partial<ProviderRuleDraft>): void => {
    setDraft({ ...draft, ...next });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.fullPath}
          </Typography>
          {data.otherKeys.length > 0 && (
            <Badge tone="neutral">
              {t('providerRules.otherKeys', { keys: data.otherKeys.join(', ') })}
            </Badge>
          )}
        </Stack>

        <TextField
          label={t('providerRules.fieldDescription')}
          value={draft.description ?? ''}
          onChange={(value) => patch({ description: value })}
          hint={t('providerRules.hintDescription')}
          placeholder={t('providerRules.placeholderDescription')}
        />

        <TextField
          label={t('providerRules.fieldGlobs')}
          value={draft.globs ?? ''}
          onChange={(value) => patch({ globs: value })}
          hint={t('providerRules.hintGlobs')}
          placeholder="src/**/*.tsx, src/**/*.ts"
          isMono
        />

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
            <Typography variant="body-sm">{t('providerRules.fieldAlwaysApply')}</Typography>
            <Typography variant="caption" color="subtle">
              {t('providerRules.hintAlwaysApply')}
            </Typography>
          </Stack>
          <Toggle
            checked={draft.alwaysApply ?? false}
            onCheckedChange={(checked) => patch({ alwaysApply: checked })}
            aria-label={t('providerRules.fieldAlwaysApply')}
          />
        </Stack>

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm">{t('providerRules.fieldBody')}</Typography>
          <textarea
            className={styles.editor}
            value={draft.body}
            onChange={(event) => patch({ body: event.target.value })}
            spellCheck={false}
            aria-label={t('providerRules.fieldBody')}
          />
        </Stack>

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="caption" color="subtle">
            {t('claudeMd.chars', { count: draft.body.length })}
            {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('providerRules.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="check" size={18} />}
              onClick={() => save.mutate({ ...draft, path: data.path })}
              isLoading={save.isPending}
              disabled={!dirty}
            >
              {t('common.save')}
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
}

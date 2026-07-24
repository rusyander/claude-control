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
import { useProviderRules, useDeleteProviderRule } from '@entities/ProviderRules';
import { ProviderRuleEditor } from './ProviderRuleEditor';
import { ProviderRuleCreateForm } from './ProviderRuleCreateForm';

/**
 * Правила в модели КАТАЛОГА `.mdc` (CURSOR-1) — общая начинка для глобального
 * раздела и для вкладки проекта: отличается только `projectId`.
 *
 * ЧЕСТНО О МОДЕЛИ. Это НЕ редактор одного файла вроде CLAUDE.md и не список
 * ссылок. У Cursor правила лежат КАТАЛОГОМ: каждый файл `.mdc` — отдельное
 * правило с YAML-frontmatter (`description`, `globs`, `alwaysApply`) и
 * markdown-телом; подкаталоги поддерживаются. Обычный `.md` в этом каталоге
 * Cursor не читает — такие файлы показаны отдельным списком и не правятся.
 */
export function ProviderRulesPanel({ projectId }: { projectId?: string }) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderRules(scope);
  const remove = useDeleteProviderRule(scope);

  const [openRule, setOpenRule] = useState<string | undefined>(undefined);

  if (isLoading || !data) return <SkeletonList rows={5} />;

  const { rules, ignored, readOnly } = data;

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerRules.explainTitle')}
        text={t('providerRules.explain', { provider: data.providerName, rulesDir: data.rulesDir })}
      />

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerRules.rulesDir')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.rulesDir}
          </Typography>
          {!data.dirExists && <Badge tone="neutral">{t('providerRules.dirMissing')}</Badge>}
        </Stack>
      </Card>

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerRules.dirUnreadable', { path: data.rulesDir })}
            </Typography>
          </Stack>
        </Card>
      )}

      {rules.length > 0 && (
        <Card padding="none">
          <Stack>
            {rules.map((rule) => (
              <Stack key={rule.path} gap="var(--spacing-2xs)" padding="var(--spacing-sm)">
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
                        {rule.path}
                      </Typography>
                      {rule.alwaysApply && (
                        <Badge tone="accent">{t('providerRules.badgeAlwaysApply')}</Badge>
                      )}
                      {!rule.frontmatterOk && (
                        <Badge tone="warning">
                          {t(
                            rule.problem === 'no_frontmatter'
                              ? 'providerRules.badgeNoFrontmatter'
                              : 'providerRules.badgeMalformed',
                          )}
                        </Badge>
                      )}
                    </Stack>
                    {rule.description && (
                      <Typography variant="body-sm" color="muted">
                        {rule.description}
                      </Typography>
                    )}
                    {rule.globs && (
                      <Typography variant="mono" color="subtle" as="span" truncate>
                        {t('providerRules.globsPrefix')} {rule.globs}
                      </Typography>
                    )}
                    <Typography variant="mono" color="subtle" as="span" truncate>
                      {rule.fullPath}
                    </Typography>
                  </Stack>

                  <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOpenRule(openRule === rule.path ? undefined : rule.path)}
                    >
                      {openRule === rule.path
                        ? t('providerRules.close')
                        : rule.frontmatterOk
                          ? t('providerRules.edit')
                          : t('providerRules.view')}
                    </Button>
                    <DeleteButton
                      entityName={rule.path}
                      description={t('providerRules.deleteRule')}
                      onDelete={() => {
                        remove.mutate(rule.path);
                        if (openRule === rule.path) setOpenRule(undefined);
                      }}
                      isPending={remove.isPending}
                    />
                  </Stack>
                </Stack>

                {openRule === rule.path && (
                  <ProviderRuleEditor
                    path={rule.path}
                    projectId={projectId}
                    onClose={() => setOpenRule(undefined)}
                  />
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {rules.length === 0 && !readOnly && (
        <Typography color="subtle">{t('providerRules.empty')}</Typography>
      )}

      {ignored.length > 0 && (
        <Card padding="sm">
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="info" size={18} />
              <Typography variant="body-sm" color="muted">
                {t('providerRules.ignoredTitle')}
              </Typography>
            </Stack>
            <Typography variant="caption" color="subtle">
              {t('providerRules.ignoredExplain')}
            </Typography>
            {ignored.map((file) => (
              <Typography key={file.path} variant="mono" color="subtle" as="span" truncate>
                {file.path}
              </Typography>
            ))}
          </Stack>
        </Card>
      )}

      {!readOnly && (
        <ProviderRuleCreateForm
          rulesDir={data.rulesDir}
          existing={rules.map((rule) => rule.path)}
          projectId={projectId}
          onCreated={setOpenRule}
        />
      )}

      <Typography variant="caption" color="subtle">
        {t('common.needsRestart')}
      </Typography>
    </Stack>
  );
}

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useCreateParam } from '@shared/hooks/use-create-param';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SearchField } from '@shared/ui/search-field';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { RuleFormModal } from '@features/RuleEditor';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { ruleApi } from '@entities/Rule';
import type { Rule } from '@claude-control/contracts';
import styles from './RulesPage.module.scss';

/** Раздел личных правил из CLAUDE.md. */
export function RulesPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Rule | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: rules = [], isLoading } = ruleApi.useList();
  const setEnabled = ruleApi.useSetEnabled();
  const deleteRule = ruleApi.useDelete();

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (rule: Rule): void => {
    setEditing(rule);
    setIsFormOpen(true);
    writeUrl(rule.id);
  };

  // Ссылка /rules?id=<id> открывает это правило сразу в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<Rule>({ items: rules, getId: (rule) => rule.id, onOpen: openEdit });
  // Быстрое действие «Добавить» с обзора: /rules?create=1 сразу открывает форму.
  useCreateParam(openCreate);

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rules;
    return rules.filter(
      (rule) =>
        rule.title.toLowerCase().includes(needle) || rule.body.toLowerCase().includes(needle),
    );
  }, [rules, query]);

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('rules.title')}
        subtitle={t('rules.subtitle')}
        helpTopic="rules"
        actions={
          <Button variant="primary" leftIcon={<Icon name="plus" size={24} />} onClick={openCreate}>
            {t('rules.addRule')}
          </Button>
        }
      />

      <ExplainBox title={t('rules.explainTitle')} text={t('rules.explain')} />

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t('common.search')}
        label={t('common.search')}
      />

      {isLoading && <SkeletonList rows={5} />}

      <Stack gap="var(--spacing-sm)">
        {filtered.map((rule) => (
          <Card key={rule.id} padding="md">
            <Stack direction="row" gap="var(--spacing-md)" align="start" width="100%">
              <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium" as="span">
                    {rule.title}
                  </Typography>
                  {!rule.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
                </Stack>
                <Typography variant="body-sm" color="muted" clamp={3} className={styles.body}>
                  {rule.body}
                </Typography>
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
                <SandboxButton
                  kind="rule"
                  title={rule.title}
                  selection={{ ruleIds: [rule.id] }}
                  context={{ body: rule.body }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${rule.title}`}
                  onClick={() => openEdit(rule)}
                />
                <DeleteButton
                  entityName={rule.title}
                  description={t('common.deleteRule')}
                  onDelete={() => deleteRule.mutate(rule.id)}
                  isPending={deleteRule.isPending}
                />
                <Toggle
                  checked={rule.isEnabled}
                  onCheckedChange={(isEnabled) => setEnabled.mutate({ id: rule.id, isEnabled })}
                  aria-label={rule.title}
                />
              </Stack>
            </Stack>
          </Card>
        ))}
      </Stack>

      {!isLoading && filtered.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <RuleFormModal isOpen={isFormOpen} onOpenChange={closeForm} rule={editing} />
    </Stack>
  );
}

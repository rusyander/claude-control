import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionDecision, PermissionRule } from '@claude-control/contracts';
import { Icon } from '@shared/ui/icon';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { SkeletonList } from '@shared/ui/skeleton';
import { PermissionFormModal } from '@features/PermissionEditor';
import { DeleteButton } from '@features/EntityDelete';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SearchField } from '@shared/ui/search-field';
import { VirtualList } from '@shared/ui/virtual-list';
import { TruncatedText } from '@shared/ui/truncated-text';
import { permissionApi } from '@entities/Permission';
import { SystemPermissions } from './SystemPermissions';
import styles from './PermissionsPage.module.scss';

const TONE: Record<PermissionDecision, 'success' | 'warning' | 'danger'> = {
  allow: 'success',
  ask: 'warning',
  deny: 'danger',
};

/** Раздел прав доступа с фильтром по типу решения. */
export function PermissionsPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PermissionDecision | 'all'>('all');
  const [editing, setEditing] = useState<PermissionRule | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [tab, setTab] = useState<'system' | 'mcp' | 'all'>('system');
  const [presetPattern, setPresetPattern] = useState<string | undefined>(undefined);

  const { data: rules = [], isLoading } = permissionApi.useList();
  const deleteRule = permissionApi.useDelete();

  const openCreate = (pattern?: string): void => {
    setEditing(undefined);
    setPresetPattern(pattern);
    setIsFormOpen(true);
  };

  const openEdit = (rule: PermissionRule): void => {
    setEditing(rule);
    setPresetPattern(undefined);
    setIsFormOpen(true);
    writeUrl(rule.id);
  };

  // Ссылка /permissions?id=<решение:шаблон> открывает это право.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<PermissionRule>({ items: rules, getId: (rule) => rule.id, onOpen: openEdit });

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rules.filter((rule) => {
      // Вкладка MCP показывает только правила серверов: их больше сотни,
      // и в общем списке они забивают всё остальное.
      const matchesTab = tab !== 'mcp' || Boolean(rule.mcpServer);
      const matchesFilter = filter === 'all' || rule.decision === filter;
      const matchesQuery = !needle || rule.pattern.toLowerCase().includes(needle);
      return matchesTab && matchesFilter && matchesQuery;
    });
  }, [rules, query, filter, tab]);

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('permissions.title')}
        subtitle={t('permissions.subtitle')}
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={() => openCreate()}
          >
            {t('permissions.addRule')}
          </Button>
        }
      />

      <ExplainBox title={t('permissions.explainTitle')} text={t('permissions.explain')} />

      <Stack direction="row" gap="var(--spacing-2xs)" wrap>
        {(['system', 'mcp', 'all'] as const).map((value) => (
          <Button
            key={value}
            variant={tab === value ? 'primary' : 'secondary'}
            onClick={() => setTab(value)}
          >
            {t(`permissions.tab${value[0]?.toUpperCase()}${value.slice(1)}`)}
          </Button>
        ))}
      </Stack>

      {tab === 'system' && (
        <SystemPermissions rules={rules} onEdit={openEdit} onCreate={openCreate} />
      )}

      {tab !== 'system' && (
        <Stack direction="row" gap="var(--spacing-sm)" wrap align="center">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t('common.search')}
            label={t('common.search')}
          />

          <Stack direction="row" gap="var(--spacing-2xs)">
            {(['all', 'allow', 'ask', 'deny'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? 'primary' : 'ghost'}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? t('common.total') : t(`permissions.${value}`)}
              </Button>
            ))}
          </Stack>
        </Stack>
      )}

      {isLoading && <SkeletonList rows={5} />}

      {tab !== 'system' && (
        <Card padding="none">
          <VirtualList
            items={filtered}
            rowHeight={41}
            height={560}
            getKey={(rule) => rule.id}
            renderRow={(rule) => (
              <Stack
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-sm)"
                className={styles.row}
              >
                <TruncatedText text={rule.pattern} variant="mono" />

                <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                  <Badge tone={TONE[rule.decision]} withDot>
                    {t(`permissions.${rule.decision}`)}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Icon name="edit" size={24} />}
                    aria-label={`${t('common.edit')}: ${rule.pattern}`}
                    onClick={() => openEdit(rule)}
                  />
                  <DeleteButton
                    entityName={rule.pattern}
                    description={t('permissions.deletePermission')}
                    onDelete={() => deleteRule.mutate(rule.id)}
                    isPending={deleteRule.isPending}
                  />
                </Stack>
              </Stack>
            )}
          />
        </Card>
      )}

      {tab !== 'system' && !isLoading && filtered.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <PermissionFormModal
        isOpen={isFormOpen}
        onOpenChange={closeForm}
        rule={editing}
        initialPattern={presetPattern}
      />
    </Stack>
  );
}

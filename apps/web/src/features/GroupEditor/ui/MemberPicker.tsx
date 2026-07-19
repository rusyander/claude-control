import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EntityKind, EntityRef } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { SearchField } from '@shared/ui/search-field';
import { Badge } from '@shared/ui/badge';
import { ruleApi } from '@entities/Rule';
import { skillApi } from '@entities/Skill';
import { hookApi } from '@entities/Hook';
import { mcpServerApi } from '@entities/McpServer';
import type { MemberPickerProps } from './MemberPicker.types';
import styles from './GroupFormModal.module.scss';

/**
 * Выбор участников группы. Группа объединяет сущности разных типов, поэтому
 * список сводный: правила, скиллы, хуки и серверы в одном месте с фильтром
 * по типу — иначе пришлось бы прыгать между четырьмя отдельными списками.
 */
export function MemberPicker({ value, onChange }: MemberPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<EntityKind | 'all'>('all');

  const rules = ruleApi.useList().data ?? [];
  const skills = skillApi.useList().data ?? [];
  const hooks = hookApi.useList().data ?? [];
  const servers = mcpServerApi.useList().data ?? [];

  const items: Array<{ kind: EntityKind; id: string; label: string }> = [
    ...rules.map((item) => ({ kind: 'rule' as const, id: item.id, label: item.title })),
    ...skills.map((item) => ({ kind: 'skill' as const, id: item.id, label: item.name })),
    ...hooks.map((item) => ({
      kind: 'hook' as const,
      id: item.id,
      label: `${item.event}${item.matcher ? ` · ${item.matcher}` : ''}`,
    })),
    ...servers.map((item) => ({ kind: 'mcp' as const, id: item.id, label: item.name })),
  ];

  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    const matchesKind = kindFilter === 'all' || item.kind === kindFilter;
    const matchesQuery = !needle || item.label.toLowerCase().includes(needle);
    return matchesKind && matchesQuery;
  });

  const isSelected = (ref: { kind: EntityKind; id: string }): boolean =>
    value.some((member) => member.kind === ref.kind && member.id === ref.id);

  const toggle = (ref: EntityRef): void => {
    onChange(
      isSelected(ref)
        ? value.filter((member) => !(member.kind === ref.kind && member.id === ref.id))
        : [...value, ref],
    );
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('common.search')}
          label={t('common.search')}
        />
        <Stack direction="row" gap="var(--spacing-2xs)" wrap>
          {(['all', 'rule', 'skill', 'hook', 'mcp'] as const).map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={kindFilter === kind ? 'primary' : 'ghost'}
              onClick={() => setKindFilter(kind)}
            >
              {kind === 'all' ? t('common.total') : t(`groups.kind_${kind}`)}
            </Button>
          ))}
        </Stack>
      </Stack>

      <Stack className={styles.memberList}>
        {filtered.map((item) => (
          <label key={`${item.kind}:${item.id}`} className={styles.memberRow}>
            <input
              type="checkbox"
              checked={isSelected(item)}
              onChange={() => toggle({ kind: item.kind, id: item.id })}
            />
            <Badge tone="neutral">{t(`groups.kind_${item.kind}`)}</Badge>
            <Typography variant="body-sm" as="span" truncate>
              {item.label}
            </Typography>
          </label>
        ))}

        {filtered.length === 0 && (
          <Typography variant="body-sm" color="subtle">
            {t('common.empty')}
          </Typography>
        )}
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('groups.selectedCount', { count: value.length })}
      </Typography>
    </Stack>
  );
}

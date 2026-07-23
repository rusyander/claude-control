import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupMember, GroupMemberKind } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import { Badge } from '@shared/ui/badge';
import { ruleApi } from '@entities/Rule';
import { skillApi } from '@entities/Skill';
import { hookApi } from '@entities/Hook';
import { mcpServerApi } from '@entities/McpServer';
import { useGroups } from '@entities/Group';
import type { MemberPickerProps } from './MemberPicker.types';
import styles from './GroupFormModal.module.scss';

/** Виды-фильтры выбора участников: сущности плюс вложенная группа. */
const KIND_FILTERS = ['all', 'rule', 'skill', 'hook', 'mcp', 'group'] as const;

/**
 * Выбор участников группы. Группа объединяет сущности разных типов и даже другие
 * группы, поэтому список сводный: правила, скиллы, хуки, серверы и группы в
 * одном месте с фильтром по типу.
 *
 * Порядок участников значим (задаёт порядок обхода), поэтому под списком выбора
 * идёт упорядоченный список выбранного со стрелками ↑/↓ — там его и меняют.
 */
export function MemberPicker({ value, onChange, excludeGroupId }: MemberPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<GroupMemberKind | 'all'>('all');

  const rules = ruleApi.useList().data ?? [];
  const skills = skillApi.useList().data ?? [];
  const hooks = hookApi.useList().data ?? [];
  const servers = mcpServerApi.useList().data ?? [];
  const { data: groups = [] } = useGroups();

  const items: Array<{ kind: GroupMemberKind; id: string; label: string }> = [
    ...rules.map((item) => ({ kind: 'rule' as const, id: item.id, label: item.title })),
    ...skills.map((item) => ({ kind: 'skill' as const, id: item.id, label: item.name })),
    ...hooks.map((item) => ({
      kind: 'hook' as const,
      id: item.id,
      label: `${item.event}${item.matcher ? ` · ${item.matcher}` : ''}`,
    })),
    ...servers.map((item) => ({ kind: 'mcp' as const, id: item.id, label: item.name })),
    // Себя в участники добавить нельзя — исключаем правящуюся группу из списка.
    ...groups
      .filter((item) => item.id !== excludeGroupId)
      .map((item) => ({ kind: 'group' as const, id: item.id, label: item.name })),
  ];

  const labelByKey = new Map(items.map((item) => [`${item.kind}:${item.id}`, item.label]));
  const labelOf = (member: GroupMember): string =>
    labelByKey.get(`${member.kind}:${member.id}`) ?? member.id;

  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    const matchesKind = kindFilter === 'all' || item.kind === kindFilter;
    const matchesQuery = !needle || item.label.toLowerCase().includes(needle);
    return matchesKind && matchesQuery;
  });

  const isSelected = (ref: { kind: GroupMemberKind; id: string }): boolean =>
    value.some((member) => member.kind === ref.kind && member.id === ref.id);

  const toggle = (ref: GroupMember): void => {
    onChange(
      isSelected(ref)
        ? value.filter((member) => !(member.kind === ref.kind && member.id === ref.id))
        : [...value, ref],
    );
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const current = value[index];
    const neighbour = value[target];
    if (!current || !neighbour) return;
    const next = [...value];
    next[index] = neighbour;
    next[target] = current;
    onChange(next);
  };

  const removeAt = (index: number): void => {
    onChange(value.filter((_, position) => position !== index));
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
          {KIND_FILTERS.map((kind) => (
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

      {value.length > 0 && (
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="caption" color="subtle">
            {t('groups.orderTitle')}
          </Typography>
          <Stack className={styles.orderList}>
            {value.map((member, index) => (
              <Stack
                key={`${member.kind}:${member.id}`}
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-xs)"
                className={styles.orderRow}
              >
                <Stack
                  direction="row"
                  align="center"
                  gap="var(--spacing-xs)"
                  className={styles.orderLabel}
                >
                  <Typography variant="caption" color="subtle" as="span">
                    {index + 1}
                  </Typography>
                  <Badge tone="neutral">{t(`groups.kind_${member.kind}`)}</Badge>
                  <Typography variant="body-sm" as="span" truncate>
                    {labelOf(member)}
                  </Typography>
                </Stack>
                <Stack direction="row" gap="var(--spacing-2xs)" flexShrink={0}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="chevronUp" size={20} />}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={t('groups.moveUp')}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="chevronDown" size={20} />}
                    disabled={index === value.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={t('groups.moveDown')}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="close" size={20} />}
                    onClick={() => removeAt(index)}
                    aria-label={t('groups.removeMember')}
                  />
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Stack>
      )}

      <Typography variant="caption" color="subtle">
        {t('groups.selectedCount', { count: value.length })}
      </Typography>
    </Stack>
  );
}

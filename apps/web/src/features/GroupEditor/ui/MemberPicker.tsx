import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupMember, GroupMemberKind } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { SearchField } from '@shared/ui/search-field';
import { Badge } from '@shared/ui/badge';
import { memberLivesIn, pickedMember, useGroupMembers } from '@entities/Group';
import { hookLabel } from '../model/memberCatalog';
import { useMemberCatalog } from '../model/useMemberCatalog';
import type { MemberPickerProps } from './MemberPicker.types';
import { KIND_FILTERS } from './MemberPicker.constants';
import { MemberOrderList } from './MemberOrderList';
import styles from './GroupFormModal.module.scss';

/**
 * Выбор участников группы. Группа объединяет сущности разных типов и даже другие
 * группы, поэтому список сводный: правила, скиллы, хуки, серверы и группы в
 * одном месте с фильтром по типу.
 *
 * Порядок участников значим (задаёт порядок обхода), поэтому под списком выбора
 * идёт упорядоченный список выбранного: словами, со стрелками ↑/↓ и «+» между
 * строками — отмеченный после «+» участник встаёт на это место, а не в конец.
 */
function insertMember(
  value: GroupMember[],
  ref: GroupMember,
  at: number | undefined,
): GroupMember[] {
  if (at === undefined || at >= value.length) return [...value, ref];
  return [...value.slice(0, at), ref, ...value.slice(at)];
}

export function MemberPicker({ value, onChange, excludeGroupId, groupScope }: MemberPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<GroupMemberKind | 'all'>('all');
  const [insertAt, setInsertAt] = useState<number | undefined>(undefined);
  // Описания словами есть только у сохранённой группы; у новой — имена из списков.
  const described = useGroupMembers(excludeGroupId ?? '', Boolean(excludeGroupId)).data;

  // Каталог общий с помощником формы: он предлагает ровно то, что можно отметить здесь.
  const { items, skills, hooks, groups } = useMemberCatalog(excludeGroupId);

  // Подписи упорядоченного списка — по ВСЕМ сущностям, а не только по тем, что
  // предлагает выбор: локальный хук в выбор не попадает, но, будучи уже в
  // составе, должен читаться событием, а не «local:Event:hash».
  const labelByKey = new Map(items.map((item) => [`${item.kind}:${item.id}`, item.label]));
  for (const item of hooks) labelByKey.set(`hook:${item.id}`, hookLabel(item));
  const labelOf = (member: GroupMember): string =>
    labelByKey.get(`${member.kind}:${member.id}`) ?? member.id;

  // Строка из самого файла участника — пока модель не описала его словами.
  const rawLineOf = (member: GroupMember): string => {
    if (member.kind === 'skill')
      return skills.find((item) => item.id === member.id)?.description ?? '';
    if (member.kind === 'hook') return hooks.find((item) => item.id === member.id)?.command ?? '';
    if (member.kind === 'group')
      return groups.find((item) => item.id === member.id)?.description ?? '';
    return '';
  };

  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    const matchesKind = kindFilter === 'all' || item.kind === kindFilter;
    const matchesQuery = !needle || item.label.toLowerCase().includes(needle);
    return matchesKind && matchesQuery;
  });

  // Списки здесь — общие: проектный тёзка того же id выбранным не считается.
  const isRef = (member: GroupMember, ref: { kind: GroupMemberKind; id: string }): boolean =>
    member.kind === ref.kind &&
    member.id === ref.id &&
    memberLivesIn(groupScope, member) === 'global';
  const isSelected = (ref: { kind: GroupMemberKind; id: string }): boolean =>
    value.some((member) => isRef(member, ref));

  const toggle = (ref: GroupMember): void => {
    onChange(
      isSelected(ref)
        ? value.filter((member) => !isRef(member, ref))
        : insertMember(value, pickedMember(groupScope, ref.kind, ref.id, 'global'), insertAt),
    );
    // Место вставки — номер позиции: после любого изменения списка он указывал бы
    // на другого соседа, и следующий выбор встал бы не туда, куда метили.
    setInsertAt(undefined);
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
    setInsertAt(undefined);
  };

  const removeAt = (index: number): void => {
    onChange(value.filter((_, position) => position !== index));
    setInsertAt(undefined);
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
              {t(`groups.kind_${kind}`)}
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
          <MemberOrderList
            value={value}
            labelOf={labelOf}
            rawLineOf={rawLineOf}
            described={described}
            insertAt={insertAt}
            onInsertAt={setInsertAt}
            onMove={move}
            onRemove={removeAt}
          />
        </Stack>
      )}

      <Typography variant="caption" color="subtle">
        {t('groups.selectedCount', { count: value.length })}
      </Typography>
    </Stack>
  );
}

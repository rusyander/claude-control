import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { TestGroupListProps } from './TestGroupList.types';
import styles from './TestGroupList.module.scss';

/**
 * Группы кейсов — списком в левой колонке, над деревом секций.
 *
 * Раньше это был ряд вкладок над таблицей: на двух десятках групп он занимал
 * пять строк и уводил сами кейсы за низ экрана. Столбец растёт вниз, а не
 * вширь, и читается так же, как дерево наборов в TestRail и Qase: где я, что
 * рядом, сколько в каждом.
 *
 * Счётчик — отдельной колонкой, а не в скобках после названия: длинное имя
 * обрезается многоточием, и число при этом остаётся видно.
 */
export function TestGroupList({ groups, activeId, onSelect, onAdd }: TestGroupListProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-3xs)" as="nav" aria-label={t('tests.library.groups')}>
      <Typography variant="caption" color="subtle">
        {t('tests.library.groups')}
      </Typography>

      {groups.map((group) => {
        const isActive = group.id === activeId;
        return (
          <button
            key={group.id}
            type="button"
            className={[styles.section, isActive && styles.sectionActive].filter(Boolean).join(' ')}
            aria-current={isActive ? 'true' : undefined}
            title={group.title}
            onClick={() => onSelect(group.id)}
          >
            <span className={styles.sectionTitle}>{group.title}</span>
            <span className={styles.sectionCount}>
              {group.error ? <Icon name="warning" size={14} /> : group.cases.length}
            </span>
          </button>
        );
      })}

      <Button variant="ghost" size="sm" leftIcon={<Icon name="plus" size={16} />} onClick={onAdd}>
        {t('projectTests.addGroup')}
      </Button>
    </Stack>
  );
}

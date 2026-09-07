import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { flattenSections } from '@entities/ProjectTest';
import type { TestSectionTreeProps } from './TestSectionTree.types';
import styles from './ProjectTests.module.scss';

/**
 * Дерево секций слева.
 *
 * Секция — это поле кейса, путь вида «Чат/Вложения», а не отдельная сущность:
 * дерево рисуется по тому, что написано в кейсах. Выбор ветки включает и всё,
 * что под ней, — так же, как это делает отбор.
 *
 * Дерево плоское по разметке (отступ считается глубиной): рекурсивные списки
 * ломают порядок обхода Tab и превращают навигацию клавиатурой в лотерею.
 */
export function TestSectionTree({ sections, total, selected, onSelect }: TestSectionTreeProps) {
  const { t } = useTranslation();
  const rows = flattenSections(sections);

  return (
    <Stack gap="var(--spacing-3xs)" as="nav" aria-label={t('tests.library.sections')}>
      <Typography variant="caption" color="subtle">
        {t('tests.library.sections')}
      </Typography>

      <button
        type="button"
        className={[styles.section, selected === '' && styles.sectionActive]
          .filter(Boolean)
          .join(' ')}
        aria-current={selected === '' ? 'true' : undefined}
        onClick={() => onSelect('')}
      >
        <span className={styles.sectionTitle}>{t('tests.library.allSections')}</span>
        <span className={styles.sectionCount}>{total}</span>
      </button>

      {rows.map((node) => (
        <button
          key={node.path}
          type="button"
          className={[styles.section, selected === node.path && styles.sectionActive]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: `calc(var(--spacing-xs) + ${node.depth * 14}px)` }}
          aria-current={selected === node.path ? 'true' : undefined}
          title={node.path}
          onClick={() => onSelect(node.path)}
        >
          <span className={styles.sectionTitle}>{node.title}</span>
          <span className={styles.sectionCount}>{node.count}</span>
        </button>
      ))}

      {rows.length === 0 && (
        <Typography variant="caption" color="subtle">
          {t('tests.library.sectionsEmpty')}
        </Typography>
      )}
    </Stack>
  );
}

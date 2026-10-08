import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import type { PathToolbarProps } from './PathToolbar.types';
import styles from './PathToolbar.module.scss';

/**
 * Панель над длинным путём — прилипает к верху окна: поиск шага, сколько их и
 * сколько видно, свернуть/развернуть блоки скиллов, добавить шаг в конец.
 * Живая область здесь же: её слышно, где бы ни стоял фокус.
 */
export function PathToolbar({
  query,
  onQuery,
  total,
  shown,
  hasBlocks,
  isAllOpen,
  onToggleAll,
  isEmpty,
  onAdd,
  announcement,
}: PathToolbarProps) {
  const { t } = useTranslation();
  const isFiltered = query.trim().length > 0;
  // Итог фильтра — вслух: счётчик рядом не живой, и диктор молчал, сколько
  // шагов осталось (или что не осталось ни одного). Без фильтра — перенос шага.
  const filterResult =
    shown === 0 ? t('groupBuilder.noMatch') : t('groupBuilder.toolbar.shown', { shown, total });
  const said = isFiltered ? filterResult : announcement;
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={t('groupBuilder.toolbar.label')}>
      {!isEmpty && (
        <div className={styles.search}>
          <SearchField
            value={query}
            onChange={onQuery}
            label={t('groupBuilder.toolbar.filterLabel')}
            placeholder={t('groupBuilder.toolbar.filterPlaceholder')}
          />
        </div>
      )}
      <span className={styles.count}>
        {isFiltered
          ? t('groupBuilder.toolbar.shown', { shown, total })
          : t('groupBuilder.toolbar.total', { count: total })}
      </span>
      <div className={styles.actions}>
        {hasBlocks && !isFiltered && (
          <Button size="sm" variant="ghost" onClick={onToggleAll}>
            {isAllOpen
              ? t('groupBuilder.toolbar.collapseAll')
              : t('groupBuilder.toolbar.expandAll')}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Icon name="plus" size={16} />}
          onClick={onAdd}
        >
          {isEmpty ? t('groupBuilder.toolbar.addFirst') : t('groupBuilder.toolbar.addStep')}
        </Button>
      </div>
      <span className={styles.live} role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

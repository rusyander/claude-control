import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import { Toggle } from '@shared/ui/toggle';
import { LOG_LEVELS } from '../../lib/logParse';
import type { LogToolbarProps } from './Logs.types';
import styles from './Logs.module.scss';

/**
 * Поиск, порог уровня, слежение и очистка. Порог — «этот уровень и важнее»:
 * на «Предупреждениях» видны и ошибки, иначе причина падения прячется от
 * того, кто ищет её начало. Число на кнопке — сколько строк она покажет.
 */
export function LogToolbar({
  search,
  onSearchChange,
  shown,
  total,
  level,
  onLevelChange,
  counts,
  follow,
  onFollowChange,
  onClear,
}: LogToolbarProps) {
  const { t } = useTranslation();
  let running = 0;
  const cumulative = LOG_LEVELS.map((item) => {
    running += counts[item];
    return { level: item, count: running };
  });

  return (
    <div className={styles.toolbar}>
      <div className={styles.searchGroup}>
        <div className={styles.searchBox}>
          <SearchField
            label={t('environment.logs.toolbar.search')}
            value={search}
            onChange={onSearchChange}
            placeholder={t('environment.logs.toolbar.searchPlaceholder')}
          />
        </div>
        <span className={styles.matches} aria-live="polite">
          {t('environment.logs.toolbar.matches', { shown, total })}
        </span>
      </div>
      <div className={styles.levels} role="group" aria-label={t('environment.logs.toolbar.level')}>
        <button
          type="button"
          className={styles.levelChip}
          aria-pressed={level === undefined}
          onClick={() => onLevelChange(undefined)}
        >
          {t('environment.logs.toolbar.levels.all')}
          <span className={styles.levelCount}>{total}</span>
        </button>
        {cumulative.map((item) => {
          const name = t(`environment.logs.toolbar.levels.${item.level}`);
          return (
            <button
              key={item.level}
              type="button"
              className={styles.levelChip}
              data-level={item.level}
              aria-pressed={level === item.level}
              title={t('environment.logs.toolbar.levelHint', { level: name })}
              onClick={() => onLevelChange(item.level)}
            >
              {name}
              <span className={styles.levelCount}>{item.count}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.toolbarActions}>
        <label className={styles.follow} title={t('environment.logs.toolbar.followHint')}>
          <Toggle
            size="sm"
            checked={follow}
            onCheckedChange={onFollowChange}
            aria-label={t('environment.logs.toolbar.follow')}
          />
          <span aria-hidden="true">{t('environment.logs.toolbar.follow')}</span>
        </label>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="trash" size={14} />}
          title={t('environment.logs.toolbar.clearHint')}
          onClick={onClear}
          disabled={total === 0}
        >
          {t('environment.logs.toolbar.clear')}
        </Button>
      </div>
    </div>
  );
}

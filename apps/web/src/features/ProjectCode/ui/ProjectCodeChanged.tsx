import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { ProjectCodeChangedProps } from './ProjectCodeChanged.types';
import styles from './ProjectCode.module.scss';

/**
 * Плоский список того, что агент поменял в этом разговоре.
 *
 * Плоский, а не дерево: правки одного разговора обычно лежат в разных ветках
 * проекта, и раскрывать до каждой по три уровня — работа ради работы. Файлы,
 * которых уже нет на диске, показываются отдельной строкой и не открываются:
 * агент их правил, а потом они были удалены или переименованы.
 */
export function ProjectCodeChanged({
  changes,
  isLoading,
  selected,
  onSelect,
}: ProjectCodeChangedProps) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <Typography variant="caption" color="subtle" className={styles.treeNote}>
        {t('common.loading')}
      </Typography>
    );
  }

  const files = changes?.files ?? [];
  if (files.length === 0) {
    return (
      <Typography variant="caption" color="subtle" className={styles.treeNote}>
        {t('projectCode.noChanges')}
      </Typography>
    );
  }

  return (
    <div className={styles.tree}>
      {files.map((entry) => (
        <button
          key={entry.path}
          type="button"
          disabled={entry.missing}
          className={`${styles.node} ${selected === entry.path ? styles.nodeActive : ''}`}
          onClick={() => onSelect(entry.path)}
        >
          <Icon name="file" size={18} />
          <span className={styles.nodeName} title={entry.path}>
            {entry.path}
          </span>
          {entry.missing ? (
            <span className={styles.nodeCounts}>{t('projectCode.missing')}</span>
          ) : (
            <span className={styles.nodeCounts}>
              <span className={styles.added}>+{entry.added}</span>
              <span className={styles.removed}>−{entry.removed}</span>
            </span>
          )}
        </button>
      ))}

      {changes && changes.skipped > 0 && (
        <Typography variant="caption" color="subtle" className={styles.treeNote}>
          {t('projectCode.skipped', { count: changes.skipped })}
        </Typography>
      )}
    </div>
  );
}

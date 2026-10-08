import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { ProjectCodeChangedProps } from './ProjectCodeChanged.types';
import styles from './ProjectCodeChanged.module.scss';
import { ChangedNode } from './ChangedNode/ChangedNode';

/**
 * Что в проекте изменено: правки агента за этот разговор и всё остальное, что
 * git видит в рабочем дереве.
 *
 * Плоский список, а не дерево: правки одного разговора обычно лежат в разных
 * ветках проекта, и раскрывать до каждой по три уровня — работа ради работы.
 *
 * Сверху строка итога — ветка и числа: за ними в это окно и приходят, а искать
 * их, пересчитывая строки списка глазами, значит не ответить на вопрос вовсе.
 * Файлы, которых уже нет на диске, показываются отдельной строкой и не
 * открываются: агент их правил, а потом они были удалены или переименованы.
 */
export function ProjectCodeChanged({
  rows,
  git,
  isLoading,
  skipped,
  selected,
  onSelect,
}: ProjectCodeChangedProps) {
  const { t } = useTranslation();

  if (isLoading && rows.length === 0) {
    return (
      <Typography variant="caption" color="subtle" className={styles.treeNote}>
        {t('common.loading')}
      </Typography>
    );
  }

  if (rows.length === 0) {
    return (
      <Typography variant="caption" color="subtle" className={styles.treeNote}>
        {t('projectCode.noChanges')}
      </Typography>
    );
  }

  const agent = rows.filter((row) => row.source === 'agent');
  const tracked = rows.filter((row) => row.source === 'git');
  const summary = [
    git?.branch ? t('projectCode.summaryBranch', { branch: git.branch }) : '',
    t('projectCode.summary', { count: rows.length }),
    git?.insertions === undefined || git.deletions === undefined
      ? ''
      : t('projectCode.summaryLines', { added: git.insertions, removed: git.deletions }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.tree}>
      <Typography variant="caption" color="subtle" className={styles.changedSummary}>
        {summary}
      </Typography>

      {/* Заголовки источников появляются только когда есть оба: у пустого
          разговора «В рабочем дереве» над единственным списком — шум. */}
      {agent.length > 0 && tracked.length > 0 && (
        <Typography variant="caption" color="subtle" className={styles.changedGroup}>
          {t('projectCode.fromAgent')}
        </Typography>
      )}
      {agent.map((row) => (
        <ChangedNode
          key={row.path}
          row={row}
          isActive={selected === row.path}
          onSelect={onSelect}
          missingLabel={t('projectCode.missing')}
        />
      ))}

      {agent.length > 0 && tracked.length > 0 && (
        <Typography variant="caption" color="subtle" className={styles.changedGroup}>
          {t('projectCode.fromGit')}
        </Typography>
      )}
      {tracked.map((row) => (
        <ChangedNode
          key={row.path}
          row={row}
          isActive={selected === row.path}
          onSelect={onSelect}
          missingLabel={t('projectCode.missing')}
        />
      ))}

      {skipped !== undefined && skipped > 0 && (
        <Typography variant="caption" color="subtle" className={styles.treeNote}>
          {t('projectCode.skipped', { count: skipped })}
        </Typography>
      )}
    </div>
  );
}

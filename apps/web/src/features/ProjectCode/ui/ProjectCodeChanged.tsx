import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { STATUS_LETTER } from '@shared/config/git-status-letter';
import { splitPath } from '@shared/lib/file-path';
import type { ChangedRow } from '../lib/changedRows';
import type { ProjectCodeChangedProps } from './ProjectCodeChanged.types';
import styles from './ProjectCode.module.scss';

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

interface ChangedNodeProps {
  row: ChangedRow;
  isActive: boolean;
  onSelect: (path: string) => void;
  missingLabel: string;
}

/**
 * Одна строка списка. Справа — числа строк там, где они посчитаны (правки
 * агента), и буква состояния git там, где считать нечего: у нового файла нет
 * прежней версии, а «+0 −0» читалось бы как «ничего не изменилось».
 */
function ChangedNode({ row, isActive, onSelect, missingLabel }: ChangedNodeProps) {
  return (
    <button
      type="button"
      disabled={row.missing}
      className={`${styles.node} ${isActive ? styles.nodeActive : ''}`}
      onClick={() => onSelect(row.path)}
    >
      <Icon name="file" size={18} />
      {/* Сжимается каталог, имя файла остаётся целым: ищут глазами именно его,
          а обрезка с конца прятала ровно его — в глубоких путях монорепы от
          строки оставалось «apps/web/src/features/Proje…». */}
      <span className={styles.nodePath} title={row.path}>
        <span className={styles.nodeDir}>{splitPath(row.path).dir}</span>
        <span className={styles.nodeFile}>{splitPath(row.path).name}</span>
      </span>
      {row.missing ? (
        <span className={styles.nodeCounts}>{missingLabel}</span>
      ) : (
        <span className={styles.nodeCounts}>
          {row.added !== undefined && row.removed !== undefined && (
            <>
              <span className={styles.added}>+{row.added}</span>
              <span className={styles.removed}>−{row.removed}</span>
            </>
          )}
          {row.status && <span className={styles.gitStatus}>{STATUS_LETTER[row.status]}</span>}
        </span>
      )}
    </button>
  );
}

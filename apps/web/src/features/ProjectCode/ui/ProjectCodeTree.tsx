import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { useProjectTree } from '@entities/ProjectFile';
import type { ProjectCodeTreeProps, ProjectCodeBranchProps } from './ProjectCodeTree.types';
import styles from './ProjectCode.module.scss';

/**
 * Дерево файлов проекта — все файлы, а не только тронутые.
 *
 * Каждая ветка запрашивает своё содержимое сама и только когда её раскрыли:
 * целиком настоящий репозиторий не читается — это десятки тысяч записей ради
 * двух-трёх открытых папок. Поэтому ветка — отдельный компонент со своим
 * запросом, а не рекурсивный обход заранее загруженного дерева.
 *
 * Работа агента видна прямо здесь: у изменённого файла зелёное имя и счётчики
 * строк, у папки на пути к нему — зелёная точка. Иначе найти результат прогона
 * в дереве можно было бы только перебором папок.
 *
 * Список раскрытых папок хранится СНАРУЖИ, в состоянии окна: он переживает и
 * закрытие окна, и перезагрузку панели, потому что сохраняется у таба проекта.
 */
export function ProjectCodeTree(props: ProjectCodeTreeProps) {
  return (
    <div className={styles.tree} role="tree" aria-label="files">
      <ProjectCodeBranch {...props} dir="" depth={0} />
    </div>
  );
}

/** Один уровень дерева: содержимое одного каталога. */
function ProjectCodeBranch({
  projectPath,
  dir,
  depth,
  selected,
  changes,
  changedDirs,
  openDirs,
  onToggleDir,
  onSelect,
}: ProjectCodeBranchProps) {
  const { t } = useTranslation();
  const tree = useProjectTree(projectPath, dir);

  if (tree.isLoading) {
    return (
      <Typography variant="caption" color="subtle" className={styles.treeNote}>
        {t('common.loading')}
      </Typography>
    );
  }

  const entries = tree.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <Typography variant="caption" color="subtle" className={styles.treeNote}>
        {t('projectCode.emptyFolder')}
      </Typography>
    );
  }

  return (
    <>
      {entries.map((entry) => {
        const isOpen = openDirs.includes(entry.path);
        const change = changes.get(entry.path);
        const inside = entry.isDir && changedDirs.has(entry.path);

        return (
          <div key={entry.path}>
            <button
              type="button"
              className={[
                styles.node,
                selected === entry.path && styles.nodeActive,
                change && styles.nodeChanged,
                inside && styles.nodeInside,
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `calc(${depth} * var(--spacing-sm) + var(--spacing-2xs))` }}
              aria-expanded={entry.isDir ? isOpen : undefined}
              onClick={() => (entry.isDir ? onToggleDir(entry.path) : onSelect(entry.path))}
            >
              {entry.isDir ? (
                <Icon
                  name="chevronRight"
                  size={16}
                  className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
                />
              ) : (
                <span className={styles.chevronSpacer} />
              )}
              <span className={styles.nodeIcon}>
                <Icon name={entry.isDir ? 'folder' : 'file'} size={18} />
              </span>
              <span className={styles.nodeName}>{entry.name}</span>
              {change && (
                <span className={styles.nodeCounts}>
                  <span className={styles.added}>+{change.added}</span>
                  <span className={styles.removed}>−{change.removed}</span>
                </span>
              )}
            </button>

            {entry.isDir && isOpen && (
              <ProjectCodeBranch
                projectPath={projectPath}
                dir={entry.path}
                depth={depth + 1}
                selected={selected}
                changes={changes}
                changedDirs={changedDirs}
                openDirs={openDirs}
                onToggleDir={onToggleDir}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}

      {tree.data?.truncated && (
        <Typography variant="caption" color="subtle" className={styles.treeNote}>
          {t('projectCode.truncated')}
        </Typography>
      )}
    </>
  );
}

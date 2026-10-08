import type { ProjectCodeBranchProps } from '../ProjectCodeTree.types';
import { useTranslation } from 'react-i18next';
import { useProjectTree } from '@entities/ProjectFile';
import { Typography } from '@shared/ui/typography';
import styles from './ProjectCodeBranch.module.scss';
import { Icon } from '@shared/ui/icon';
import { STATUS_LETTER } from '@shared/config/git-status-letter';

/** Один уровень дерева: содержимое одного каталога. */
export function ProjectCodeBranch({
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
                  {change.added !== undefined && change.removed !== undefined && (
                    <>
                      <span className={styles.added}>+{change.added}</span>
                      <span className={styles.removed}>−{change.removed}</span>
                    </>
                  )}
                  {change.status && (
                    <span className={styles.gitStatus}>{STATUS_LETTER[change.status]}</span>
                  )}
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

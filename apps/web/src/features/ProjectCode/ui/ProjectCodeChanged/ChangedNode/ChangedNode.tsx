import type { ChangedNodeProps } from './ChangedNode.types';
import styles from './ChangedNode.module.scss';
import { Icon } from '@shared/ui/icon';
import { splitPath } from '@shared/lib/file-path';
import { STATUS_LETTER } from '@shared/config/git-status-letter';

/**
 * Одна строка списка. Справа — числа строк там, где они посчитаны (правки
 * агента), и буква состояния git там, где считать нечего: у нового файла нет
 * прежней версии, а «+0 −0» читалось бы как «ничего не изменилось».
 */
export function ChangedNode({ row, isActive, onSelect, missingLabel }: ChangedNodeProps) {
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

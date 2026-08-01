import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { countFiles } from '../model/buildTree';
import { cancelCreate, isCreatingIn } from '../model/createTarget';
import { NewNodeInput } from './NewNodeInput';
import type { TreeItemProps } from './TreeItem.types';
import styles from './ResourceFileTree.module.scss';

export function TreeItem({
  node,
  selected,
  creatingIn,
  isWritable,
  onSelect,
  onCreateIn,
  onCreateFile,
  onDelete,
  defaultOpen = false,
}: TreeItemProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(defaultOpen);

  if (!node.isDirectory) {
    return (
      <div className={`${styles.node} ${selected === node.path ? styles.nodeActive : ''}`}>
        <button type="button" className={styles.nodeMain} onClick={() => onSelect(node.path)}>
          <Icon name="file" size={16} />
          <span className={styles.name}>{node.name}</span>
        </button>

        {isWritable && (
          <span className={styles.nodeActions}>
            <button
              type="button"
              className={styles.nodeAction}
              aria-label={`${t('common.delete')}: ${node.path}`}
              onClick={() => onDelete(node)}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      <div className={styles.node}>
        <button type="button" className={styles.nodeMain} onClick={() => setIsOpen((v) => !v)}>
          <Icon
            name="chevronRight"
            size={16}
            className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
          />
          <Icon name="folder" size={16} />
          <span className={styles.name}>{node.name}</span>
          <span className={styles.count}>{countFiles(node)}</span>
        </button>

        {isWritable && (
          <span className={styles.nodeActions}>
            <button
              type="button"
              className={styles.nodeAction}
              aria-label={`${t('resources.newFile')}: ${node.path}`}
              onClick={() => {
                setIsOpen(true);
                onCreateIn(node.path);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className={styles.nodeAction}
              aria-label={`${t('common.delete')}: ${node.path}`}
              onClick={() => onDelete(node)}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        )}
      </div>

      {isOpen && (
        <div className={styles.children}>
          {isCreatingIn(creatingIn, node.path) && (
            <NewNodeInput
              placeholder="notes.md"
              // Отмена ЗАКРЫВАЕТ поле. Пустая строка здесь означала бы корень:
              // Escape в папке открывал ввод имени наверху дерева.
              onCancel={() => onCreateIn(cancelCreate())}
              onSubmit={(name) => onCreateFile(node.path, name)}
            />
          )}

          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              selected={selected}
              creatingIn={creatingIn}
              isWritable={isWritable}
              onSelect={onSelect}
              onCreateIn={onCreateIn}
              onCreateFile={onCreateFile}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </>
  );
}

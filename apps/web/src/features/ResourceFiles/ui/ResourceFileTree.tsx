import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import {
  useResourceFiles,
  useSaveResourceFile,
  useDeleteResourceFile,
  useResourceTemplates,
  useApplyTemplate,
  type ResourceKind,
} from '@entities/Resource/api/ResourceApi';
import { buildTree, countFiles, type TreeNode } from '../model/buildTree';
import { ResourceFileEditor } from './ResourceFileEditor';
import { StructureAssistant } from './StructureAssistant';
import styles from './ResourceFileTree.module.scss';

interface ResourceFileTreeProps {
  kind: ResourceKind;
  id: string;
}

/**
 * Файлы ресурса деревом с правкой на месте.
 *
 * Компонент один на все виды: скилл раскрывается папкой с вложенными
 * файлами, скрипт — одним файлом, плагин — своей структурой только на
 * чтение. Что именно можно делать, решает сервер и сообщает флагом.
 */
export function ResourceFileTree({ kind, id }: ResourceFileTreeProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** Куда добавляем файл: путь папки или пустая строка для корня. */
  const [creatingIn, setCreatingIn] = useState<string | undefined>(undefined);

  const data = useResourceFiles(kind, id);
  const save = useSaveResourceFile(kind, id);
  const remove = useDeleteResourceFile(kind, id);
  const templates = useResourceTemplates(kind);
  const applyTemplate = useApplyTemplate(kind, id);

  const files = data.data?.files ?? [];
  const isWritable = data.data?.isWritable ?? false;

  const tree = useMemo(() => buildTree(files.map((file) => file.path)), [files]);

  /**
   * Новый файл создаётся сразу пустым: отдельного черновика нет, иначе
   * пришлось бы держать несохранённое дерево параллельно настоящему.
   * Папка появляется вместе с первым файлом — пустых папок всё равно не бывает.
   */
  const createFile = (folder: string, name: string): void => {
    const path = folder ? `${folder}/${name}` : name;

    save.mutate({ file: path, content: '' }, { onSuccess: () => setSelected(path) });
    setCreatingIn(undefined);
  };

  // Пустому ресурсу предлагаем шаблон: начинать с чистого листа тяжелее,
  // чем дополнить готовую форму.
  if (files.length === 0 && !data.isLoading) {
    return (
      <div className={styles.tree}>
        {isWritable && (templates.data?.length ?? 0) > 0 ? (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="caption" color="subtle">
              {t('resources.startFromTemplate')}
            </Typography>

            {templates.data?.map((template) => (
              <button
                key={template.id}
                type="button"
                className={styles.template}
                onClick={() => applyTemplate.mutate(template.id)}
                disabled={applyTemplate.isPending}
              >
                <Stack gap="var(--spacing-3xs)">
                  <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                    <Icon name="skills" size={16} />
                    <Typography variant="body-sm" weight="medium" as="span">
                      {template.title}
                    </Typography>
                    <Typography variant="caption" color="subtle" as="span">
                      {template.fileCount} · {template.paths.join(', ')}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" color="muted">
                    {template.description}
                  </Typography>
                </Stack>
              </button>
            ))}

            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Icon name="plus" size={16} />}
              onClick={() => setCreatingIn('')}
            >
              {t('resources.emptyStart')}
            </Button>

            {creatingIn === '' && (
              <NewNodeInput
                placeholder="SKILL.md"
                onCancel={() => setCreatingIn(undefined)}
                onSubmit={(name) => createFile('', name)}
              />
            )}

            {/* Помощник умеет собрать структуру с нуля — по описанию задачи. */}
            <StructureAssistant kind={kind} id={id} />
          </Stack>
        ) : (
          <Typography variant="caption" color="subtle">
            {t('resources.noFiles')}
          </Typography>
        )}
      </div>
    );
  }

  return (
    <div className={styles.tree}>
      <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)">
        <Typography variant="caption" color="subtle">
          {isWritable ? t('resources.treeHint') : t('resources.readOnlyHint')}
        </Typography>

        {isWritable && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={() => setCreatingIn('')}
          >
            {t('resources.newFile')}
          </Button>
        )}
      </Stack>

      {creatingIn === '' && (
        <NewNodeInput
          placeholder="references/notes.md"
          onCancel={() => setCreatingIn(undefined)}
          onSubmit={(name) => createFile('', name)}
        />
      )}

      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          selected={selected}
          creatingIn={creatingIn}
          isWritable={isWritable}
          onSelect={setSelected}
          onCreateIn={setCreatingIn}
          onCreateFile={createFile}
          onDelete={(path) => {
            remove.mutate(path);
            if (selected === path) setSelected(undefined);
          }}
          // Первый уровень раскрыт сразу: иначе видно только названия папок
          // и приходится кликать дважды.
          defaultOpen
        />
      ))}

      {selected && (
        <ResourceFileEditor
          kind={kind}
          id={id}
          file={selected}
          isWritable={isWritable}
          onClose={() => setSelected(undefined)}
        />
      )}

      {isWritable && <StructureAssistant kind={kind} id={id} />}
    </div>
  );
}

interface TreeItemProps {
  node: TreeNode;
  selected?: string;
  creatingIn?: string;
  isWritable: boolean;
  onSelect: (path: string) => void;
  onCreateIn: (folder: string) => void;
  onCreateFile: (folder: string, name: string) => void;
  onDelete: (path: string) => void;
  defaultOpen?: boolean;
}

function TreeItem({
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
              onClick={() => onDelete(node.path)}
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
              onClick={() => onDelete(node.path)}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        )}
      </div>

      {isOpen && (
        <div className={styles.children}>
          {creatingIn === node.path && (
            <NewNodeInput
              placeholder="notes.md"
              onCancel={() => onCreateIn('')}
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

/**
 * Поле имени прямо в дереве — как в редакторах кода. Enter создаёт, Escape
 * отменяет; отдельного окна ради одного имени не нужно.
 */
function NewNodeInput({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');

  return (
    <div className={styles.newNode}>
      <Icon name="file" size={16} />
      <input
        className={styles.newNodeInput}
        value={name}
        placeholder={placeholder}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && name.trim()) onSubmit(name.trim());
          if (event.key === 'Escape') onCancel();
        }}
        onBlur={() => !name.trim() && onCancel()}
      />
    </div>
  );
}

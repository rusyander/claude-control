import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import {
  useResourceFiles,
  useSaveResourceFile,
  useDeleteResourceFile,
  useResourceTemplates,
  useApplyTemplate,
} from '@entities/Resource';
import { buildTree } from '../model/buildTree';
import { planDelete, isRemovedByDelete, type DeletePlan } from '../model/deletePlan';
import {
  cancelCreate,
  isCreatingIn,
  CREATE_IN_ROOT,
  type CreateTarget,
} from '../model/createTarget';
import { NewNodeInput } from './NewNodeInput';
import { TreeItem } from './TreeItem';
import { ResourceFileEditor } from './ResourceFileEditor';
import { StructureAssistant } from './StructureAssistant';
import type { ResourceFileTreeProps } from './ResourceFileTree.types';
import styles from './ResourceFileTree.module.scss';

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
  /** Куда добавляем файл: путь папки, '' — корень, undefined — поля нет. */
  const [creatingIn, setCreatingIn] = useState<CreateTarget>(undefined);
  /** Что ждёт подтверждения удаления; пусто — диалога нет. */
  const [pendingDelete, setPendingDelete] = useState<DeletePlan | undefined>(undefined);

  const data = useResourceFiles(kind, id);
  const save = useSaveResourceFile(kind, id);
  const remove = useDeleteResourceFile(kind, id);
  const templates = useResourceTemplates(kind);
  const applyTemplate = useApplyTemplate(kind, id);

  // `?? []` каждый раз даёт новый массив, поэтому мемо ключуем по самому ответу:
  // иначе дерево пересобиралось бы на каждом рендере.
  const files = data.data?.files;
  const isWritable = data.data?.isWritable ?? false;

  const tree = useMemo(() => buildTree((files ?? []).map((file) => file.path)), [files]);

  /**
   * Новый файл создаётся сразу пустым: отдельного черновика нет, иначе
   * пришлось бы держать несохранённое дерево параллельно настоящему.
   * Папка появляется вместе с первым файлом — пустых папок всё равно не бывает.
   */
  const createFile = (folder: string, name: string): void => {
    const path = folder ? `${folder}/${name}` : name;

    save.mutate({ file: path, content: '' }, { onSuccess: () => setSelected(path) });
    setCreatingIn(cancelCreate());
  };

  // Пустому ресурсу предлагаем шаблон: начинать с чистого листа тяжелее,
  // чем дополнить готовую форму.
  if ((files?.length ?? 0) === 0 && !data.isLoading) {
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
              onClick={() => setCreatingIn(CREATE_IN_ROOT)}
            >
              {t('resources.emptyStart')}
            </Button>

            {isCreatingIn(creatingIn, CREATE_IN_ROOT) && (
              <NewNodeInput
                placeholder="SKILL.md"
                onCancel={() => setCreatingIn(cancelCreate())}
                onSubmit={(name) => createFile(CREATE_IN_ROOT, name)}
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
            onClick={() => setCreatingIn(CREATE_IN_ROOT)}
          >
            {t('resources.newFile')}
          </Button>
        )}
      </Stack>

      {isCreatingIn(creatingIn, CREATE_IN_ROOT) && (
        <NewNodeInput
          placeholder="references/notes.md"
          onCancel={() => setCreatingIn(cancelCreate())}
          onSubmit={(name) => createFile(CREATE_IN_ROOT, name)}
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
          // Не удаляем по клику: у папки сервер сносит всю вложенность разом, а
          // отмены нет — только ручное копание в бэкапах. Спрашиваем, как и
          // остальные удаления в панели.
          onDelete={(target) => setPendingDelete(planDelete(target))}
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

      {pendingDelete && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => !open && setPendingDelete(undefined)}
          onConfirm={() => {
            remove.mutate(pendingDelete.path);
            if (isRemovedByDelete(selected, pendingDelete.path)) setSelected(undefined);
            setPendingDelete(undefined);
          }}
          title={t('common.deleteTitle')}
          description={
            pendingDelete.isDirectory
              ? t('resources.deleteFolderWarn', {
                  path: pendingDelete.path,
                  count: pendingDelete.fileCount,
                })
              : t('resources.deleteFileWarn', { path: pendingDelete.path })
          }
          confirmationName={pendingDelete.name}
          confirmLabel={t('common.delete')}
          isPending={remove.isPending}
        />
      )}
    </div>
  );
}

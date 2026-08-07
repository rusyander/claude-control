import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectFileContent } from '@claude-control/contracts';
import { Modal } from '@shared/ui/modal';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import { TabButton } from '@shared/ui/tab-button';
import { ResizeHandle } from '@shared/ui/resize-handle';
import { Typography } from '@shared/ui/typography';
import { useProjectCode } from '../model/useProjectCode';
import { useTreeWidth } from '../model/useTreeWidth';
import { bodyKind, canEditText, defaultTab, hasBothSides, type CodeTab } from '../lib/previewMode';
import { ProjectCodeTree } from './ProjectCodeTree';
import { ProjectCodeChanged } from './ProjectCodeChanged';
import { ProjectCodeEditor } from './ProjectCodeEditor';
import { ProjectCodePreview } from './ProjectCodePreview';
import { ProjectCodeStatus } from './ProjectCodeStatus';
import type { ProjectCodeModalProps } from './ProjectCodeModal.types';
import styles from './ProjectCode.module.scss';

/**
 * Окно кода проекта: слева файлы, справа один открытый файл с подсветкой,
 * диффом правок агента и возможностью тут же его поправить.
 *
 * Два списка вместо фильтра по дереву: «Изменённые» — плоский перечень того,
 * что тронул агент в этом разговоре, и именно он открывается первым. Дерево
 * нужно, когда идёшь смотреть соседний файл, а не результат работы.
 */
export function ProjectCodeModal({
  isOpen,
  onOpenChange,
  projectPath,
  chatId,
}: ProjectCodeModalProps) {
  const { t } = useTranslation();
  const code = useProjectCode(projectPath, chatId, isOpen);
  const tree = useTreeWidth(isOpen);
  const file = code.shown;

  // Вкладка выбирается человеком, но существует не у всякого файла: у картинки
  // нет исходника, у кода — показа. Поэтому выбор держится отдельно, а что
  // рисовать на самом деле, решает `bodyKind` по возможностям файла.
  const [tab, setTab] = useState<CodeTab>('code');
  const [previewText, setPreviewText] = useState('');

  // Сброс идёт по смене ФАЙЛА, а не по каждому ответу сервера: содержимое
  // перезапрашивается с нулевой свежестью, и завязка на его объект возвращала бы
  // человека на вкладку по умолчанию посреди правки.
  useEffect(() => {
    // Вернулись к файлу с недописанной правкой — открываем там, где её бросили.
    const hasDraft = file ? code.draftOf(file.path) !== undefined : false;
    setTab(hasDraft ? 'code' : defaultTab(file));
    setPreviewText(code.readDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path]);

  // Закрытие с несохранённым — единственное место, где работа человека может
  // пропасть насовсем: переключение файлов её сохраняет, а закрытие стирает
  // всё. Поэтому здесь спрашивают, а не молча выбрасывают.
  const [isDiscardOpen, setDiscardOpen] = useState(false);

  const requestClose = (open: boolean): void => {
    if (!open && code.dirtyFiles.length > 0) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(open);
  };

  const discard = (): void => {
    code.dropDrafts();
    setDiscardOpen(false);
    onOpenChange(false);
  };

  // Показ SVG и разметки собирается из набранного текста, а не из файла на
  // диске: снимаем его в момент перехода на вкладку — по букве это стоило бы
  // перерисовки всего окна на каждое нажатие клавиши.
  const openPreview = (): void => {
    setPreviewText(code.readDraft());
    setTab('preview');
  };

  const body = code.selected ? bodyKind(file, tab) : 'placeholder';
  const isEditorShown = body === 'editor';

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={requestClose}
      title={t('projectCode.title')}
      description={projectPath}
      size="full"
      bodyFill
    >
      <div
        className={styles.layout}
        style={{ gridTemplateColumns: `${tree.width}px auto minmax(0, 1fr)` }}
      >
        <aside className={styles.sidebar}>
          <Stack direction="row" gap="var(--spacing-3xs)" className={styles.sidebarTabs}>
            <TabButton isActive={code.onlyChanged} onClick={() => code.setOnlyChanged(true)}>
              {t('projectCode.tabChanged', { count: code.changed.size })}
            </TabButton>
            <TabButton isActive={!code.onlyChanged} onClick={() => code.setOnlyChanged(false)}>
              {t('projectCode.tabAll')}
            </TabButton>
          </Stack>

          {code.onlyChanged ? (
            <ProjectCodeChanged
              changes={code.changes.data}
              isLoading={code.changes.isLoading}
              selected={code.selected}
              onSelect={code.select}
            />
          ) : (
            <ProjectCodeTree
              projectPath={projectPath}
              selected={code.selected}
              changes={code.changed}
              changedDirs={code.changedDirs}
              openDirs={code.openDirs}
              onToggleDir={code.toggleDir}
              onSelect={code.select}
            />
          )}
        </aside>

        {/*
          Тот же разделитель, что у превью артефактов, только тянет левую
          колонку. Мышью и стрелками — перетаскивание, доступное лишь мышью,
          для части пользователей означает «недоступно вовсе».
        */}
        <div className={styles.resizer} data-testid="project-code-resizer">
          <ResizeHandle
            side="left"
            width={tree.width}
            onResize={tree.setWidth}
            min={tree.min}
            max={tree.max}
            label={t('projectCode.resize')}
          />
        </div>

        <section className={styles.main}>
          <Stack
            direction="row"
            align="center"
            justify="between"
            gap="var(--spacing-sm)"
            className={styles.mainHeader}
          >
            <Typography variant="mono" color="muted" as="span" truncate>
              {code.selected ?? t('projectCode.nothingOpen')}
              {code.isDirty && ' •'}
            </Typography>

            <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
              {hasBothSides(file) && (
                <Stack direction="row" gap="var(--spacing-3xs)">
                  <TabButton isActive={tab === 'code'} onClick={() => setTab('code')}>
                    {t('projectCode.tabCode')}
                  </TabButton>
                  <TabButton isActive={tab === 'preview'} onClick={openPreview}>
                    {t('projectCode.tabPreview')}
                  </TabButton>
                </Stack>
              )}

              {/*
                У картинки, PDF и всего, что не открылось, править и сравнивать
                нечего — тумблер и «Сохранить» там не выключены, а отсутствуют:
                выключенная кнопка обещает работу, которой у файла нет.
              */}
              {canEditText(file) && (
                <>
                  <Stack as="label" direction="row" align="center" gap="var(--spacing-2xs)">
                    <Toggle
                      size="sm"
                      checked={code.showDiff}
                      onCheckedChange={code.setShowDiff}
                      aria-label={t('projectCode.showDiff')}
                    />
                    <Typography variant="caption" color="subtle" as="span">
                      {t('projectCode.showDiff')}
                    </Typography>
                  </Stack>

                  <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<Icon name="check" size={18} />}
                    disabled={!code.isDirty || !code.isEditable}
                    isLoading={code.isSaving}
                    onClick={code.saveDraft}
                  >
                    {t('common.save')}
                  </Button>
                </>
              )}
            </Stack>
          </Stack>

          <div className={styles.editorArea}>
            {isEditorShown && file && (
              <ProjectCodeEditor
                path={file.path}
                content={code.draftOf(file.path) ?? file.content}
                baseline={file.baseline}
                mtimeMs={file.mtimeMs}
                isEditable={code.isEditable}
                showDiff={code.showDiff}
                onChange={code.changeDraft}
                onSave={code.saveDraft}
              />
            )}

            {body === 'preview' && file && (
              <ProjectCodePreview projectPath={projectPath} file={file} text={previewText} />
            )}

            {body === 'placeholder' && (
              <Typography variant="body-sm" color="subtle" className={styles.placeholder}>
                {placeholderKey(code.isSwitching, file, t)}
              </Typography>
            )}

            {body !== 'placeholder' && code.isSwitching && (
              <div className={styles.loading}>
                <Typography variant="body-sm" color="subtle">
                  {t('common.loading')}
                </Typography>
              </div>
            )}
          </div>

          <ProjectCodeStatus file={code.isSwitching ? undefined : file} />
        </section>
      </div>

      <ConfirmDialog
        isOpen={isDiscardOpen}
        onOpenChange={setDiscardOpen}
        onConfirm={discard}
        title={t('projectCode.discardTitle')}
        description={t('projectCode.discardText', {
          count: code.dirtyFiles.length,
          files: code.dirtyFiles.join(', '),
        })}
        confirmLabel={t('projectCode.discardConfirm')}
      />
    </Modal>
  );
}

/**
 * Что написать вместо редактора: файл не выбран, грузится, велик, двоичный.
 * Размер идёт раньше двоичности: у картинки верно и то и другое, но человеку
 * важна причина отказа, а она здесь — вес.
 */
function placeholderKey(
  isSwitching: boolean,
  file: ProjectFileContent | undefined,
  t: (key: string) => string,
): string {
  if (isSwitching) return t('common.loading');
  if (!file) return t('projectCode.pickFile');
  if (file.tooBig) return t('projectCode.tooBig');
  if (file.isBinary) return t('projectCode.binary');
  return t('projectCode.tooBig');
}

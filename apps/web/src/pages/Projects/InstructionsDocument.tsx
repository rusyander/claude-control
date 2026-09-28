import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { EmptyState } from '@shared/ui/empty-state';
import { renderDocumentMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { cn } from '@shared/lib/cn';
import { ProjectCodeEditor } from '@features/ProjectCode';
import { SourceLine } from './SourceLine';
import type { InstructionsDocumentProps } from './InstructionsDocument.types';
import styles from './ProjectsPage.module.scss';

/**
 * Файл инструкций проекта: по умолчанию — документ для чтения, правка — явным
 * «Править».
 *
 * Раньше вкладка открывалась огромным полем с сырым текстом: оно занимало экран,
 * было редактируемым с первого взгляда и не говорило, что здесь главное. Теперь
 * читается разметка, а правится тем же редактором, что и файлы в окне кода, —
 * подсветка Markdown, сворачивание разделов, поиск, Ctrl+S. Кнопки сохранения
 * стоят над документом, где их ищут, и видны, пока есть что сохранять, даже
 * после возврата к просмотру.
 *
 * Документ дотягивается до низа окна, а длинный файл растёт вместе со страницей:
 * прокрутка у страницы одна (колонка раздела), своя прокрутка внутри поля
 * давала бы вторую. Чтобы кнопки не уезжали с длинным файлом, полоса над
 * документом липнет к верху колонки.
 */
export function InstructionsDocument({
  fileName,
  filePath,
  exists,
  value,
  onChange,
  isDirty,
  changedElsewhere = false,
  isSaving,
  onSave,
  onRevert,
  version,
  restartHint,
  aside,
}: InstructionsDocumentProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const html = useMemo(() => (isEditing ? '' : renderDocumentMarkdown(value)), [isEditing, value]);

  const save = (): void => {
    if (isDirty && !isSaving) onSave();
  };

  const renderPreview = () => {
    if (!exists && !isDirty) {
      return (
        <div className={styles.docEmpty}>
          <EmptyState
            icon="file"
            title={t('projectsPage.doc.noFileTitle', { file: fileName })}
            text={t('projectsPage.doc.noFileText')}
            action={
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="edit" size={18} />}
                onClick={() => setIsEditing(true)}
              >
                {t('projectsPage.doc.createFile', { file: fileName })}
              </Button>
            }
          />
        </div>
      );
    }
    if (value.trim() === '') {
      return (
        <div className={styles.docEmpty}>
          <Typography variant="body-sm" color="subtle">
            {t('projectsPage.doc.emptyFile')}
          </Typography>
        </div>
      );
    }
    return (
      // Разметку собирает markdown-it с выключенным html: сырых тегов из файла
      // репозитория в страницу панели не попадёт. Картинки — ссылками: чужой
      // адрес из файла панель сама не запрашивает.
      <article
        className={styles.preview}
        aria-label={t('projectsPage.doc.previewLabel', { file: fileName })}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  };

  return (
    <div className={styles.docContainer}>
      <div className={styles.doc}>
        <div className={styles.docToolbar}>
          <SourceLine isEditable path={filePath} />

          <div className={styles.docActions}>
            {isDirty && (
              <Typography variant="caption" color="warning" as="span">
                {t('claudeMd.unsaved')}
              </Typography>
            )}
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name={isEditing ? 'eye' : 'edit'} size={18} />}
              onClick={() => setIsEditing((current) => !current)}
            >
              {isEditing ? t('projectsPage.doc.preview') : t('projectsPage.doc.edit')}
            </Button>
            {(isEditing || isDirty) && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onRevert}
                  disabled={!isDirty || isSaving}
                >
                  {t('claudeMd.revert')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Icon name="check" size={18} />}
                  onClick={save}
                  isLoading={isSaving}
                  disabled={!isDirty}
                >
                  {t('common.save')}
                </Button>
              </>
            )}
          </div>
        </div>

        {changedElsewhere && (
          <Typography variant="body-sm" color="warning" role="status">
            {t('projectsPage.doc.changedElsewhere', { file: fileName })}
          </Typography>
        )}

        {aside && <div className={styles.docFiles}>{aside}</div>}

        <div className={cn(styles.docBody, isEditing && styles.docBodyEditing)}>
          {isEditing ? (
            <div className={cn(styles.docScroll, styles.docEditor)}>
              <ProjectCodeEditor
                path={fileName}
                content={value}
                mtimeMs={version}
                isEditable
                showDiff={false}
                onChange={onChange}
                onSave={save}
                ariaLabel={t('projectsPage.doc.editorLabel', { file: fileName })}
                // «Править» переводит фокус в текст: иначе он оставался на
                // кнопке, и первое нажатие клавиши уходило в никуда.
                autoFocus
              />
            </div>
          ) : (
            <div className={styles.docScroll}>{renderPreview()}</div>
          )}
        </div>

        <div className={styles.docFooter}>
          <Typography variant="caption" color="subtle" as="span">
            {t('claudeMd.chars', { count: value.length })}
          </Typography>
          <Typography variant="caption" color="subtle" as="span">
            {restartHint}
          </Typography>
          {isEditing && (
            <Typography variant="caption" color="subtle" as="span">
              {t('projectsPage.doc.saveHint')}
            </Typography>
          )}
        </div>
      </div>
    </div>
  );
}

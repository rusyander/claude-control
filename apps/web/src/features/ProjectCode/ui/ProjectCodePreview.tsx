import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { projectFileRawUrl } from '@entities/ProjectFile';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { Typography } from '@shared/ui/typography';
import type { ProjectCodePreviewProps } from './ProjectCodePreview.types';
import styles from './ProjectCode.module.scss';

/**
 * Файл, показанный как файл: картинка — картинкой, PDF — документом, SVG —
 * рисунком, Markdown — разметкой.
 *
 * Двоичное берётся с сервера тегом (`img`, `iframe`), текстовое рисуется прямо
 * из содержимого редактора. Отсюда и разница в свежести: картинку перерисует
 * запись на диск, а SVG и разметку — сама правка, ещё до сохранения.
 */
export function ProjectCodePreview({ projectPath, file, text }: ProjectCodePreviewProps) {
  const { t } = useTranslation();

  // SVG идёт в `img` через data-адрес намеренно: внутри такого тега браузер не
  // выполняет ни скриптов, ни внешних загрузок, а рисунок из чужого репозитория
  // — тот же недоверенный ввод, что и текст модели.
  const svgUrl = useMemo(
    () =>
      file.preview === 'svg' && text.trim()
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
        : '',
    [file.preview, text],
  );

  const documentHtml = useMemo(
    () => (file.preview === 'markdown' ? renderMarkdown(text) : ''),
    [file.preview, text],
  );

  if (file.preview === 'image' || file.preview === 'pdf') {
    const url = projectFileRawUrl(projectPath, file.path, file.mtimeMs);

    if (file.preview === 'pdf') {
      return (
        // Файл чужой, поэтому во врезку он идёт в песочнице: просмотрщику
        // браузера её хватает, а до самой панели документ не дотянется.
        <iframe
          sandbox="allow-scripts"
          src={url}
          className={styles.previewFrame}
          title={file.path}
        />
      );
    }

    return (
      <div className={styles.previewBox}>
        <img src={url} alt={file.path} className={styles.previewImage} />
      </div>
    );
  }

  if (file.preview === 'svg') {
    if (!svgUrl) {
      return (
        <Typography variant="body-sm" color="subtle" className={styles.placeholder}>
          {t('projectCode.previewEmpty')}
        </Typography>
      );
    }

    return (
      <div className={styles.previewBox}>
        <img src={svgUrl} alt={file.path} className={styles.previewImage} />
      </div>
    );
  }

  return (
    // Разметку собирает markdown-it с выключенным html: сырых тегов из файла в
    // страницу панели не попадёт.
    <div
      className={styles.previewDocument}
      dangerouslySetInnerHTML={{ __html: documentHtml }}
      data-testid="project-code-markdown"
    />
  );
}

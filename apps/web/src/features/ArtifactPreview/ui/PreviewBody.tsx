import { artifactUrl } from '@entities/Chat';
import { ArtifactPlainText } from './ArtifactPlainText';
import type { PreviewBodyProps } from './ArtifactPreview.types';
import styles from './ArtifactPreview.module.scss';

export function PreviewBody({ chatId, artifact, documentHtml }: PreviewBodyProps) {
  const url = artifactUrl(chatId, artifact.name);

  if (artifact.kind === 'image') {
    return <img src={url} alt={artifact.name} className={styles.image} />;
  }

  if (artifact.kind === 'pdf' || artifact.kind === 'html') {
    return (
      <iframe
        // Страница сгенерирована моделью, поэтому идёт в песочницу: скрипты
        // внутри работают, но до самого приложения дотянуться не могут.
        sandbox="allow-scripts"
        src={artifact.kind === 'pdf' ? url : `${url}&as=html`}
        className={styles.frame}
        title={artifact.name}
      />
    );
  }

  if (artifact.kind === 'markdown') {
    // Разметку собирает markdown-it с выключенным html — сырых тегов из
    // ответа модели в неё не попадёт.
    return <div className={styles.document} dangerouslySetInnerHTML={{ __html: documentHtml }} />;
  }

  return <ArtifactPlainText chatId={chatId} name={artifact.name} />;
}

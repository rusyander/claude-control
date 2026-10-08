import { useTranslation } from 'react-i18next';
import { ResizeHandle } from '@shared/ui/resize-handle';
import { ArtifactPreview, MediaImageCard } from '@features/ArtifactPreview';
import { MediaDeckCard } from '@entities/Media';
import type { ChatPreviewPaneProps } from './ChatPreviewPane.types';

/**
 * Правая колонка: тянущаяся ручка и то, что в ней показывают — файл из папки
 * разговора, нарисованная панелью картинка или собранная ею колода. Столбец один
 * намеренно: две тянущиеся колонки рядом отняли бы у ленты всю ширину.
 */
export function ChatPreviewPane({
  chatId,
  artifact,
  image,
  deck,
  width,
  onResize,
  onClose,
  onReviseDeck,
}: ChatPreviewPaneProps) {
  const { t } = useTranslation();

  return (
    <>
      <ResizeHandle
        width={width}
        min={320}
        max={1000}
        label={t('chat.resizePreview')}
        onResize={onResize}
      />
      {image && <MediaImageCard image={image} onClose={onClose} />}
      {!image && deck && (
        <MediaDeckCard
          deck={deck}
          onClose={onClose}
          {...(onReviseDeck ? { onRevise: onReviseDeck } : {})}
        />
      )}
      {!image && !deck && artifact && (
        <ArtifactPreview chatId={chatId} artifact={artifact} onClose={onClose} />
      )}
    </>
  );
}

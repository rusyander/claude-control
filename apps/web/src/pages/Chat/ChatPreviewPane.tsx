import { useTranslation } from 'react-i18next';
import { ResizeHandle } from '@shared/ui/resize-handle';
import { ArtifactPreview } from '@features/ArtifactPreview';
import type { ChatPreviewPaneProps } from './ChatPreviewPane.types';

/** Правая колонка: тянущаяся ручка и предпросмотр выбранного артефакта. */
export function ChatPreviewPane({
  chatId,
  artifact,
  width,
  onResize,
  onClose,
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
      <ArtifactPreview chatId={chatId} artifact={artifact} onClose={onClose} />
    </>
  );
}

import { useCallback, useState } from 'react';
import { PREVIEW_WIDTH_KEY } from '../ChatPage.constants';

/**
 * Ширина панели предпросмотра артефакта. Значение переживает перезагрузку:
 * читается из localStorage при первом рендере и пишется туда на каждом
 * изменении размера.
 */
export function usePreviewWidth(): [number, (width: number) => void] {
  const [previewWidth, setPreviewWidth] = useState(
    () => Number(localStorage.getItem(PREVIEW_WIDTH_KEY)) || 520,
  );

  const resizePreview = useCallback((width: number) => {
    setPreviewWidth(width);
    localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
  }, []);

  return [previewWidth, resizePreview];
}

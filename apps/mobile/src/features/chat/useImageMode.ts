import { useState } from 'react';
import type { MediaImage } from '@agentdeck/contracts';
import { useT } from '../../shared/config/i18n';
import {
  createImage,
  imageModeView,
  mediaChatId,
  pictureRequest,
  planImageSubmit,
  useImagePlan,
  type ImageAction,
  type ImageModeView,
} from '../../entities/media/api';

export type ComposerMode = 'text' | 'image';

export interface ImageModeState {
  mode: ComposerMode;
  setMode: (mode: ComposerMode) => void;
  view: ImageModeView;
  drawing: boolean;
  /** Картинка, нарисованная панелью, — карточкой, не репликой. */
  shown?: MediaImage;
  close: () => void;
  /** Перечитать план: разговор живёт открытым часами, а контур могли выключить. */
  refresh: () => void;
  /**
   * Выполнить режим по тексту поля. `ask` — обычная отправка сообщения агенту
   * (дорога агента). Дорога — поле можно очистить; ложь — отказ.
   */
  submit: (
    text: string,
    ask: (prompt: string) => Promise<boolean>,
  ) => Promise<ImageAction['road'] | false>;
  /** Отказ словами сервера; поле при этом не очищается. */
  error: string;
}

/**
 * Режим «Картинка» на экране чата (Т9) — как `useChatMedia` панели.
 *
 * Две дороги, и разница видна человеку: панель рисует САМА (контур, ручка
 * картинок, свой эндпоинт) — результат файлом и карточкой, в переписке его нет;
 * либо просит АГЕНТА разговора — тогда уходит обычное сообщение с просьбой,
 * собранной сервером, и ответ приезжает в переписке. Какая дорога — решает план
 * сервера, телефон его не угадывает.
 */
export function useImageMode(chatId: string): ImageModeState {
  const t = useT();
  const [mode, setMode] = useState<ComposerMode>('text');
  const [drawing, setDrawing] = useState(false);
  const [shown, setShown] = useState<MediaImage>();
  const [error, setError] = useState('');
  const plan = useImagePlan();
  const view = imageModeView(plan.data, t.composer.mode);

  const submit = async (
    text: string,
    ask: (prompt: string) => Promise<boolean>,
  ): Promise<ImageAction['road'] | false> => {
    const action = planImageSubmit(plan.data, text);
    if (!action) {
      // Пункт заперли, пока режим был выбран (план перечитан): описание не
      // уезжает агенту обычным сообщением молча — говорим причину сервера.
      if (text.trim()) setError(view.reasonText ?? t.composer.mode.imageBlocked);
      return false;
    }
    setError('');
    setDrawing(true);
    try {
      if (action.road === 'agent') {
        return (await ask(await pictureRequest(action.topic))) ? 'agent' : false;
      }
      const created = await createImage({ chatId: mediaChatId(chatId), prompt: action.prompt });
      setShown(created);
      return 'image';
    } catch (failure) {
      setError(
        t.composer.mode.card.failed(failure instanceof Error ? failure.message : String(failure)),
      );
      return false;
    } finally {
      setDrawing(false);
    }
  };

  return {
    mode,
    // Запертый пункт не выбирается: причина стоит рядом с ним.
    setMode: (next) => {
      if (next === 'image' && !view.available) return;
      setError('');
      setMode(next);
    },
    view,
    drawing,
    ...(shown ? { shown } : {}),
    close: () => setShown(undefined),
    refresh: () => void plan.refetch(),
    submit,
    error,
  };
}

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ProviderPreviewRequest, ProviderPreviewResponse } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { useSettings } from '@entities/AppConfig';
import { WritePreviewDialog } from '../ui/WritePreviewDialog';

/**
 * Предпросмотр записи в чужой конфиг (IDEA-10) как обёртка над сохранением.
 *
 * Правка чужого CLI отличается от правки Claude одним: панель здесь гость. Файл
 * человек вёл руками, формат незнакомый, а «сохранить» ничего не показывает до
 * того, как станет поздно. Поэтому между кнопкой и записью встаёт дифф —
 * настоящий, снятый сервером с временной копии файла.
 *
 * Обёртка сделана хуком, а не отдельным экраном, чтобы место вызова менялось
 * одной строкой: `save.mutate(x)` → `ask(request, () => save.mutate(x))`. Иначе
 * предпросмотр пришлось бы вживлять в каждую форму, и часть путей записи о нём
 * бы забыли.
 *
 * Когда предпросмотра НЕ будет: активен Claude (его разделы свои и проверены)
 * или настройка выключена. Тогда `ask` просто вызывает запись — поведение
 * прежнее.
 */
export interface WritePreviewApi {
  /** Спросить подтверждение диффом; после «Записать» выполняется `commit`. */
  ask: (request: ProviderPreviewRequest, commit: () => void) => void;
  /** Диалог — вставляется в разметку страницы один раз. */
  dialog: ReactNode;
}

async function fetchPreview(request: ProviderPreviewRequest): Promise<ProviderPreviewResponse> {
  const { data } = await apiClient.post<ProviderPreviewResponse>('/provider-preview', request);
  return data;
}

export function useWritePreview(): WritePreviewApi {
  const { data: settings } = useSettings();
  const [commit, setCommit] = useState<(() => void) | undefined>(undefined);
  const preview = useMutation({ mutationFn: fetchPreview });

  const enabled = settings?.previewProviderWrites !== false && settings?.provider !== 'claude';

  const close = (): void => {
    setCommit(undefined);
    preview.reset();
  };

  const ask = (request: ProviderPreviewRequest, run: () => void): void => {
    if (!enabled) {
      run();
      return;
    }
    // Функцию в состояние кладём через обёртку: setState трактует функцию как
    // ленивое вычисление и вызвала бы запись немедленно — то есть без спроса.
    setCommit(() => run);
    preview.mutate(request);
  };

  const dialog = (
    <WritePreviewDialog
      isOpen={commit !== undefined}
      isLoading={preview.isPending}
      preview={preview.data}
      error={preview.isError}
      onCancel={close}
      onConfirm={() => {
        commit?.();
        close();
      }}
    />
  );

  return { ask, dialog };
}

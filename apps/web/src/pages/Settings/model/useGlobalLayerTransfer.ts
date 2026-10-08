import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { GlobalLayerTransferRequest } from '@agentdeck/contracts';
import { useGlobalTransfer } from '@entities/GlobalLayer';
import { saveDraft } from '@shared/lib/draft';
import { toast } from '@shared/lib/toast';
import { projectShortName, workspace } from '@shared/lib/workspace';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Перенос между копиями — задание агенту, а не запись панели: сервер собирает
 * текст, панель кладёт его в поле ввода нового чата репозитория, отправляет
 * человек. Вкладку репозитория показываем там, где она уже открыта, и забываем
 * открытый в ней разговор — задание начинает новый, а не дописывается в чужой.
 */
export function useGlobalLayerTransfer() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const transfer = useGlobalTransfer();

  const start = (id: string, body: GlobalLayerTransferRequest): void => {
    transfer.mutate(
      { id, body },
      {
        onSuccess: ({ prompt, cwd }) => {
          const tabId = workspace.reveal(cwd, projectShortName(cwd));
          workspace.rememberView(tabId, undefined);
          saveDraft(`project:${tabId}`, prompt);
          toast.success(t('settings.globalLayer.transferReady'));
          void navigate({ to: '/chat' } as never);
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return { start, isPending: transfer.isPending };
}

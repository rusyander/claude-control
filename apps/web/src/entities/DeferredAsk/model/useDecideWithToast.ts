import { useTranslation } from 'react-i18next';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { useDecideDeferredAsk } from '../api/DeferredAskApi';

/**
 * Решение по D-n с ответом человеку: записано (только записано — разговор не
 * продолжается, агенту ничего не доставляется) или почему не записалось.
 */
export function useDecideWithToast() {
  const { t } = useTranslation();
  const decide = useDecideDeferredAsk();
  const onDecide = (id: string, behavior: 'allow' | 'deny'): void => {
    decide.mutate(
      { id, behavior },
      {
        onSuccess: () => toast.success(t('deferredAsks.decided', { id })),
        onError: (error) =>
          toast.error(t('deferredAsks.failed', { message: toErrorMessage(error) })),
      },
    );
  };
  return {
    onDecide,
    busyId: decide.isPending ? decide.variables?.id : undefined,
  };
}

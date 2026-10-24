import { useTranslation } from 'react-i18next';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { useDecideDeferredAsk } from '../api/DeferredAskApi';

/**
 * Решение по D-n с ответом человеку: что стало с разговором (продолжен, после
 * паузы, после идущего хода, продолжать нечего) или почему не записалось.
 * Плашка и хаб зовут одно и то же, и тосты у них одинаковые.
 */
export function useDecideWithToast() {
  const { t } = useTranslation();
  const decide = useDecideDeferredAsk();
  const onDecide = (id: string, behavior: 'allow' | 'deny'): void => {
    decide.mutate(
      { id, behavior },
      {
        onSuccess: (result) =>
          toast.success(t(`deferredAsks.decided.${result.resume ?? 'none'}`, { id })),
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

import { useTranslation } from 'react-i18next';
import { toast } from '@shared/lib/toast';
import { useStartAllRunners } from '@entities/ProjectRunner';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * «Запустить всё» с отчётом: отказ одной цели не мешает остальным, поэтому
 * каждая отказавшая называется своим тостом — с именем и причиной, а не одним
 * «что-то не запустилось».
 */
export function useStartGroup(path: string) {
  const { t } = useTranslation();
  const startAll = useStartAllRunners();
  const run = (): void => {
    startAll.mutate(
      { path },
      {
        onSuccess: ({ failed }) => {
          for (const item of failed) {
            toast.error(t('runner.groupFailed', { name: item.name, message: item.message }));
          }
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };
  return { run, isPending: startAll.isPending };
}

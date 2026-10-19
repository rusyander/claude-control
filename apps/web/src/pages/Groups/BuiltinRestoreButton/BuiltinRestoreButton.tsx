import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { useBuiltinGroups, useRestoreBuiltinGroups } from '@entities/Group';

/**
 * «Вернуть встроенные (N)»: удалённая человеком встроенная группа сама не
 * засевается снова — вернуть её можно только здесь. Нечего возвращать —
 * кнопки нет: пустое «(0)» в шапке было бы шумом.
 */
export function BuiltinRestoreButton() {
  const { t } = useTranslation();
  const status = useBuiltinGroups();
  const restore = useRestoreBuiltinGroups();
  const count = status.data?.removed.length ?? 0;
  if (count === 0) return null;

  return (
    <Button
      leftIcon={<Icon name="refresh" size={20} />}
      isLoading={restore.isPending}
      disabled={restore.isPending}
      title={t('groupsPage.builtin.restoreHint')}
      data-testid="groups-builtin-restore"
      onClick={() =>
        restore.mutate(undefined, {
          onSuccess: ({ restored }) =>
            toast.success(t('groupsPage.builtin.restoreDone', { names: restored.join(', ') })),
        })
      }
    >
      {t('groupsPage.builtin.restore', { count })}
    </Button>
  );
}

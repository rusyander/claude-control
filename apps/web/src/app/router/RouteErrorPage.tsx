import { useEffect } from 'react';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { CrashCard } from '@shared/ui/error-boundary';

/**
 * Раздел упал при отрисовке. Дефолт роутера — голое английское «Something went
 * wrong!» на месте ВСЕЙ панели, без навигации: перейти в другой раздел нельзя,
 * помогает только F5. Здесь макет остаётся, а на месте раздела — карточка с
 * ошибкой, повтором и копированием.
 */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();

  useEffect(() => {
    console.error(`[claude-control] сбой раздела ${window.location.pathname}`, error);
  }, [error]);

  const retry = (): void => {
    reset();
    void router.invalidate();
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader title={t('common.crashTitle')} />
      <CrashCard error={error} onRetry={retry} />
    </Stack>
  );
}

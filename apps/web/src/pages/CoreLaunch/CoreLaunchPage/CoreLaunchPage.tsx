import { useTranslation } from 'react-i18next';
import { CoreHopsNotice } from '@entities/CoreTask';
import { CoreLaunchScreen, McpPicksCard } from '@features/CoreLaunch';
import { RoutesCard } from '@features/CoreRoutes';
import { PageHeader } from '@shared/ui/page-header';
import { Stack } from '@shared/ui/stack';

/**
 * Запуск задачи ядра `/core/launch` (этап 9): оценка, проверка дорог, слой, гранты, деление и
 * запуск; ниже — маршруты моделей, которыми ядро может ходить, и выбор серверов MCP человека
 * для видов шага (настройка ядра `mcpPicks`).
 */
export function CoreLaunchPage() {
  const { t } = useTranslation();
  return (
    <Stack gap="var(--spacing-lg)" data-core-launch-page>
      <PageHeader
        title={t('coreLaunch.title')}
        subtitle={t('coreLaunch.subtitle')}
        helpTopic="core"
      />
      <CoreHopsNotice />
      <CoreLaunchScreen />
      <RoutesCard />
      <McpPicksCard />
    </Stack>
  );
}

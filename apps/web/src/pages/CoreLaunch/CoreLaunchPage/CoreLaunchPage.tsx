import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CoreHopsNotice } from '@entities/CoreTask';
import { CoreLaunchScreen, LeadBlock } from '@features/CoreLaunch';
import { RoutesCard } from '@features/CoreRoutes';
import { PageHeader } from '@shared/ui/page-header';
import { Stack } from '@shared/ui/stack';

/**
 * Запуск задачи ядра `/core/launch` (этап 9): оценка, проверка дорог, слой, гранты, деление и
 * запуск; ниже — маршруты моделей, которыми ядро может ходить, и блок «Ведение задачи» (этап 11):
 * настройки ведения и выбор серверов MCP человека для видов шага. «Настроить для этого проекта»
 * на оценке ставит область карточки ведения — поэтому область живёт здесь, над обоими.
 */
export function CoreLaunchPage() {
  const { t } = useTranslation();
  const [scope, setScope] = useState('');
  const [seen, setSeen] = useState<string[]>([]);
  const scopeProject = (repoKey: string) => {
    setSeen((keys) => (keys.includes(repoKey) ? keys : [...keys, repoKey]));
    setScope(repoKey);
    document.querySelector('[data-lead-block]')?.scrollIntoView({ block: 'start' });
  };
  return (
    <Stack gap="var(--spacing-lg)" data-core-launch-page>
      <PageHeader
        title={t('coreLaunch.title')}
        subtitle={t('coreLaunch.subtitle')}
        helpTopic="core"
      />
      <CoreHopsNotice />
      <CoreLaunchScreen onLeadScope={scopeProject} />
      <RoutesCard />
      <LeadBlock scope={scope} onScope={setScope} seen={seen} />
    </Stack>
  );
}

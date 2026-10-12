import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBackendGuard } from '@entities/BackendGuard';
import { EmptyState } from '@shared/ui/empty-state';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { dbErrorCode } from '../../lib/dbError';
import { settingsKey } from '../../lib/guardError';
import { GuardForm } from './GuardForm';
import type { BackendGuardPanelProps } from './BackendGuard.types';

/**
 * Вкладка «Защита»: готовая проектная группа «хук + правило», которая
 * спрашивает человека перед командой, которую не отменить. Состояние читается
 * из файлов `.claude/` проекта; форма — черновик поверх сохранённого.
 */
export function BackendGuardPanel({ projectPath, isOpen }: BackendGuardPanelProps) {
  const { t } = useTranslation();
  const status = useBackendGuard(projectPath, isOpen);
  const [notice, setNotice] = useState<string>();

  if (status.isPending) return <SkeletonList rows={4} withActions />;
  if (status.isError) {
    if (dbErrorCode(status.error) === 'guard-project-unregistered') {
      return (
        <EmptyState
          icon="lock"
          title={t('environment.guard.title')}
          text={t('environment.guard.errors.unregistered')}
        />
      );
    }
    return <LoadErrorCard onRetry={() => void status.refetch()} />;
  }

  return (
    <GuardForm
      // Сохранённое сменилось — черновик начинается с него заново.
      key={`${status.data.state}:${settingsKey(status.data.settings)}`}
      projectPath={projectPath}
      status={status.data}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

import { useTranslation } from 'react-i18next';
import { LoadErrorCard } from '@shared/ui/load-error';
import type { SettingsLoadErrorProps } from './SettingsLoadError.types';

/** Общая карточка ошибки загрузки с текстами про настройки. */
export function SettingsLoadError({ onRetry }: SettingsLoadErrorProps) {
  const { t } = useTranslation();

  return (
    <LoadErrorCard
      title={t('settings.loadError')}
      text={t('settings.loadErrorText')}
      onRetry={onRetry}
    />
  );
}

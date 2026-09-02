import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import { sourceLabel } from '@shared/lib/location-label';
import { useLocation, useSetLocation, useUpdateSettings } from '@entities/AppConfig';
import styles from './SettingsPage.module.scss';

/**
 * Путь к каталогу .claude. Приложение находит его само, но если автоопределение
 * не сработало или каталог нестандартный — путь вводится руками и применяется
 * сразу, без перезапуска. Обратная дорога тоже кнопкой: без неё вернуться к
 * автоопределению можно было только очистив state.json руками.
 */
export function ClaudeDirField() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: location, isError: locationFailed } = useLocation();
  const setLocation = useSetLocation();
  const resetLocation = useUpdateSettings();
  const [draft, setDraft] = useState('');

  const isInvalid = location && !location.isValid;
  const isManual = location?.source === 'manual';
  const value = draft || (isManual ? location.paths.root : '');

  const apply = (): void => {
    setLocation.mutate(draft, {
      onSuccess: (result) => {
        // Тост — только когда путь принят. Раньше «Каталог настроек обновлён»
        // вспыхивал и на отказе, рядом с красным «Каталог не существует».
        if (!result.isValid) return;
        setDraft('');
        toast.success(t('toasts.locationChanged'));
      },
    });
  };

  const reset = (): void => {
    resetLocation.mutate(
      { claudeDirOverride: '' },
      {
        onSuccess: () => {
          setDraft('');
          // Смена каталога меняет вообще всё, что показывает приложение.
          void queryClient.invalidateQueries();
          toast.success(t('toasts.locationChanged'));
        },
      },
    );
  };

  return (
    <Card padding="md" isRaised={isInvalid}>
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('settings.claudeDir')}
          </Typography>
          {location && (
            <Badge tone={location.isValid ? 'success' : 'danger'} withDot>
              {sourceLabel(location, t)}
            </Badge>
          )}
        </Stack>

        {isInvalid && (
          <Typography variant="body-sm" color="danger">
            {t('errors.locationHint')}
          </Typography>
        )}

        {locationFailed && (
          <Typography variant="body-sm" color="danger">
            {t('settings.locationLoadError')}
          </Typography>
        )}

        <Typography variant="caption" color="subtle">
          {t('settings.claudeDirHint')}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <input
            className={styles.pathInput}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim()) {
                event.preventDefault();
                apply();
              }
            }}
            placeholder={location?.paths.root ?? t('settings.claudeDirPlaceholder')}
            aria-label={t('settings.claudeDir')}
            spellCheck={false}
          />
          <Button
            variant="primary"
            onClick={apply}
            isLoading={setLocation.isPending}
            disabled={!draft.trim() || setLocation.isPending}
          >
            {t('settings.apply')}
          </Button>
          {isManual && (
            <Button
              variant="secondary"
              onClick={reset}
              isLoading={resetLocation.isPending}
              disabled={resetLocation.isPending}
            >
              {t('settings.claudeDirReset')}
            </Button>
          )}
        </Stack>

        {setLocation.data && !setLocation.data.isValid && (
          <Typography variant="body-sm" color="danger">
            {setLocation.data.problem}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}

import { useTranslation } from 'react-i18next';
import { useSetTestTurnHooks, useTestTurnHooks } from '@entities/ProjectTest';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import type { TestSettingsSectionProps } from '../TestSettingsModal.types';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Проверка конца хода агента в проекте. Включена сама с добавлением проекта —
 * здесь её видно и можно выключить; выключенная не возвращается при старте
 * панели, пока человек не включит её снова.
 */
export function TestSettingsAgents({ board, onError }: TestSettingsSectionProps) {
  const { t } = useTranslation();
  const hooks = useTestTurnHooks(board.path, true);
  const setHooks = useSetTestTurnHooks(board.path);
  const state = hooks.data?.state;

  return (
    <Stack gap="var(--spacing-xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Toggle
          checked={state === 'on'}
          disabled={!state || state === 'broken' || setHooks.isPending}
          aria-label={t('tests.settings.agents.toggle')}
          onCheckedChange={(checked) => {
            onError(undefined);
            setHooks.mutate(checked, { onError: (error) => onError(toErrorMessage(error)) });
          }}
        />
        <Typography variant="body-sm" weight="medium">
          {t('tests.settings.agents.toggle')}
        </Typography>
        {state === 'on' && (
          <Typography variant="caption" color="success" as="span">
            {t('tests.settings.agents.on')}
          </Typography>
        )}
      </Stack>
      <Typography variant="caption" color="subtle">
        {t('tests.settings.agents.hint')}
      </Typography>
      {state === 'off' && (
        <Typography variant="caption">{t('tests.settings.agents.off')}</Typography>
      )}
      {state === 'broken' && (
        <Typography variant="caption" color="warning">
          {t('tests.settings.agents.broken')}
        </Typography>
      )}
    </Stack>
  );
}

import { useTranslation } from 'react-i18next';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { toast } from '@shared/lib/toast';
import { claudeModelOf, useSetLocalClaude } from '@entities/LocalModels';

interface ClaudeSwitchProps {
  info: LocalModelsInfo;
}

/**
 * «Claude Code на локальной модели» — одна галочка, выключена по умолчанию.
 * Включённая уводит сам Claude Code (терминал, расширение редактора, чаты панели)
 * на модель записью в settings.json; выключение возвращает прежние значения.
 */
export function ClaudeSwitch({ info }: ClaudeSwitchProps) {
  const { t } = useTranslation();
  const setClaude = useSetLocalClaude();
  const { claude } = info;
  const model = claudeModelOf(info);
  const label = t('localModels.claude.toggle');

  return (
    <Stack gap="var(--spacing-xs)">
      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Toggle
          checked={claude.on}
          disabled={setClaude.isPending || (!claude.on && !model)}
          aria-label={label}
          onCheckedChange={(on) =>
            setClaude.mutate(
              { on, ...(on && model ? { tag: model } : {}) },
              {
                onSuccess: () =>
                  toast.success(
                    on
                      ? t('localModels.claude.enabled', { model })
                      : t('localModels.claude.disabled'),
                  ),
              },
            )
          }
        />
        <Typography variant="heading-sm" as="h3">
          {label}
        </Typography>
      </Stack>
      <Typography variant="body-sm" color="muted">
        {t('localModels.claude.what')}
      </Typography>
      <Typography variant="body-sm">
        {claude.on
          ? t('localModels.claude.on', { model: claude.model })
          : t(model ? 'localModels.claude.off' : 'localModels.claude.noModel')}
      </Typography>
      {claude.on && claude.drift.length > 0 ? (
        <Typography variant="body-sm" color="warning">
          {t('localModels.claude.drift', { vars: claude.drift.join(', ') })}
        </Typography>
      ) : null}
      {claude.on ? (
        <Typography variant="caption" color="muted">
          {t('localModels.claude.contour')}
        </Typography>
      ) : null}
      {claude.settingsPath ? (
        <Typography variant="mono" color="muted">
          {claude.settingsPath}
        </Typography>
      ) : null}
    </Stack>
  );
}

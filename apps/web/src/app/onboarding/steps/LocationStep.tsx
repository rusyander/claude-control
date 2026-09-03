import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { sourceLabel } from '@shared/lib/location-label';
import type { LocationStepProps } from './steps.types';

/**
 * Шаг каталога конфигурации. Те же три дороги, что в карточке «Настроек»:
 * ввести путь и «Применить» (Enter в поле — то же самое), выбрать папку в окне,
 * вернуться к автоопределению. Отказ сервера показывается у поля, а не тостом:
 * человек смотрит на путь, который только что ввёл.
 */
export function LocationStep({
  location,
  onApply,
  isApplying,
  applyProblem,
  onPickFolder,
  onReset,
  isResetting,
}: LocationStepProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  // Принятый путь становится текущим каталогом — поле освобождается под следующий.
  useEffect(() => setDraft(''), [location.paths.root]);

  const isValid = location.isValid;
  const isManual = location.source === 'manual';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim() && !isApplying) onApply(draft.trim());
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Typography variant="body-sm" color="subtle">
        {t('onboarding.locationHint')}
      </Typography>

      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Badge tone={isValid ? 'success' : 'danger'} withDot>
          {sourceLabel(location, t)}
        </Badge>
        <Typography variant="mono" color="subtle" as="span" truncate>
          {location.paths.root}
        </Typography>
      </Stack>

      {!isValid && (
        <Typography variant="body-sm" color="danger">
          {location.problem ?? t('errors.locationHint')}
        </Typography>
      )}

      <form onSubmit={submit}>
        <Stack gap="var(--spacing-xs)">
          <TextField
            label={t('onboarding.pathLabel')}
            value={draft}
            onChange={setDraft}
            placeholder={t('onboarding.pathPlaceholder')}
            isMono
            error={applyProblem}
          />
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              type="submit"
              variant="primary"
              isLoading={isApplying}
              disabled={!draft.trim() || isApplying}
            >
              {t('onboarding.apply')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              leftIcon={<Icon name="folder" size={18} />}
              onClick={onPickFolder}
            >
              {t('onboarding.chooseFolder')}
            </Button>
            {isManual && (
              <Button
                type="button"
                variant="ghost"
                onClick={onReset}
                isLoading={isResetting}
                disabled={isResetting}
              >
                {t('onboarding.resetAuto')}
              </Button>
            )}
          </Stack>
        </Stack>
      </form>
    </Stack>
  );
}

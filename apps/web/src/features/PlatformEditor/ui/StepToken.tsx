import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import type { WizardStepProps } from './PlatformWizard.types';

/** Пути админки контура — из её роутера, а не из головы. */
const ADMIN_PATHS = ['/providers', '/models', '/users', '/keys'];

/**
 * Шаг 2 — ключ. Инструкция получения стоит ЗДЕСЬ, а не в справке: человек,
 * который пошёл искать её по внутренней вики, возвращается через полчаса и уже
 * без контекста.
 *
 * Поле ключа никогда не показывает сохранённое значение и никогда не
 * показывает вводимое: `type=password` без «глазика». Наружу ключ не
 * возвращается вовсе — ни в одном ответе панели его нет, только маска.
 */
export function StepToken({ model }: WizardStepProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-md)">
      <TextField
        label={t('platform.tokenLabel')}
        value={model.token}
        onChange={model.setToken}
        type="password"
        placeholder={t('platform.tokenPlaceholder')}
        hint={t('platform.tokenHint')}
        autoFocus
      />

      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <Typography variant="body-sm" color="muted">
          {t('platform.tokenStays')}
        </Typography>
        <CompromiseMark id="gateway-required" />
      </Stack>

      <Card padding="md">
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm" weight="medium" as="h3">
            {t('platform.tokenHowTitle')}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('platform.tokenHowAdmin')}
          </Typography>
          <Stack as="ol" gap="var(--spacing-2xs)">
            {ADMIN_PATHS.map((path, index) => (
              <Stack
                key={path}
                as="li"
                direction="row"
                gap="var(--spacing-2xs)"
                align="baseline"
                wrap
              >
                <Typography variant="caption" color="subtle" as="code">
                  {path}
                </Typography>
                <Typography variant="body-sm" as="span">
                  {t(`platform.tokenHowStep.${index + 1}`)}
                </Typography>
              </Stack>
            ))}
          </Stack>
          {/* Владелец ключа — не формальность: инструменты знаний работают от
              его лица, и ключ без владельца находит пустоту. */}
          <Typography variant="caption" color="muted">
            {t('platform.tokenHowOwner')}
          </Typography>
        </Stack>
      </Card>
    </Stack>
  );
}

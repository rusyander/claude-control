import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';

/** Первый шаг: три пункта о том, что панель делает и чего не делает. */
export function IntroStep() {
  const { t } = useTranslation();
  const points = [t('onboarding.point1'), t('onboarding.point2'), t('onboarding.point3')];

  return (
    <Stack gap="var(--spacing-sm)">
      {points.map((point) => (
        <Stack key={point} direction="row" gap="var(--spacing-xs)" align="start">
          <Icon name="check" size={18} />
          <Typography variant="body-sm">{point}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

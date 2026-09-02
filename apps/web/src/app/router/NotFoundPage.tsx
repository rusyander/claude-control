import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';

/**
 * Неизвестный адрес. Без своего компонента роутер рисовал голое английское
 * «Not Found» внутри макета — без заголовка и без дороги назад.
 */
export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader title={t('common.notFoundTitle')} />
      <Card padding="md">
        <Stack gap="var(--spacing-sm)" align="start">
          <Typography variant="body-sm" color="subtle">
            {t('common.notFoundText')}
          </Typography>
          <Link to="/">
            <Button variant="secondary">{t('common.notFoundHome')}</Button>
          </Link>
        </Stack>
      </Card>
    </Stack>
  );
}

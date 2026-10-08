import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { useImportKitItem } from '@entities/Kit';
import type { KitGlobalOnlyProps } from './KitGlobalOnly.types';
import styles from './KitGlobalOnly.module.scss';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Что есть у человека в глобальном слое, но не в наборе: одной кнопкой — в набор
 * копией «моё», дальше оно едет с панелью и правится здесь же.
 */
export function KitGlobalOnly({ items }: KitGlobalOnlyProps) {
  const { t } = useTranslation();
  const importer = useImportKitItem();
  if (!items.length) return null;

  return (
    <Card aria-label={t('kit.global.onlyTitle')} role="region">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="heading-sm" as="h2">
            {t('kit.global.onlyTitle')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('kit.global.onlyHint')}
          </Typography>
        </Stack>
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={`${item.kind}:${item.name}`} className={styles.row}>
              <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
                <Stack gap="var(--spacing-2xs)" className={styles.grow}>
                  <Typography variant="body" as="h3" className={styles.name}>
                    {item.name}
                  </Typography>
                  {item.description ? (
                    <Typography variant="body-sm" color="muted">
                      {item.description}
                    </Typography>
                  ) : null}
                </Stack>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importer.isPending}
                  onClick={() =>
                    importer.mutate(
                      { kind: item.kind, name: item.name },
                      {
                        onSuccess: () => toast.success(t('kit.global.imported')),
                        onError: (error) => toast.error(toErrorMessage(error)),
                      },
                    )
                  }
                >
                  {t('kit.global.take')}
                </Button>
              </Stack>
            </li>
          ))}
        </ul>
      </Stack>
    </Card>
  );
}

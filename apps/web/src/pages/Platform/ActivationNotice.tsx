import { useTranslation } from 'react-i18next';
import type { PlatformActivationNotice } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { useDismissActivationNotice } from '@entities/Platform';
import styles from './PlatformPage.module.scss';

interface ActivationNoticeProps {
  notice: PlatformActivationNotice;
}

/**
 * Разовый рассказ о переносе старых настроек: включённых контуров могло быть
 * несколько, активным стал первый.
 *
 * Молча погасить чужие тумблеры нельзя — человек включал их руками, и
 * «почему-то выключилось само» он будет искать в панели, а не в списке
 * изменений. Поэтому рассказ называет и того, кто стал активным, и всех
 * остальных поимённо, и тут же говорит главное: остальные остались
 * настроенными, их ключи и бюджеты на месте.
 *
 * Закрывается по слову человека и больше не приходит: сервер стирает запись.
 */
export function ActivationNotice({ notice }: ActivationNoticeProps) {
  const { t } = useTranslation();
  const dismiss = useDismissActivationNotice();

  return (
    <Card padding="md" className={styles.notice}>
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body" weight="medium" as="h2">
          {t('platform.migratedTitle', { title: notice.activatedTitle })}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {t('platform.migratedText', { others: notice.others.join(', ') })}
        </Typography>
        <Stack direction="row" gap="var(--spacing-2xs)">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => dismiss.mutate()}
            isLoading={dismiss.isPending}
          >
            {t('platform.migratedDismiss')}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

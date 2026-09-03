import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { CREDENTIALS_TONE, useClearCredentials, useCredentialsStatus } from '@entities/Credentials';
import type { AccessStepProps } from './steps.types';

/**
 * Шаг доступа Claude Code: откуда панель возьмёт доступ для песочницы. Чаще
 * всего делать ничего не нужно — зелёный бейдж говорит, что всё нашлось. Если
 * нет — причина словами сервера и та же форма ручного ввода, что в «Настройках».
 * Токен здесь не показывается никогда: сервер отдаёт только источник.
 */
export function AccessStep({ onSetManually }: AccessStepProps) {
  const { t } = useTranslation();
  const status = useCredentialsStatus();
  const clear = useClearCredentials();
  const data = status.data;

  return (
    <Stack gap="var(--spacing-sm)">
      <Typography variant="body-sm" color="subtle">
        {t('onboarding.accessHint')}
      </Typography>

      {status.isPending && (
        <Typography variant="body-sm" color="subtle" role="status">
          {t('onboarding.accessLoading')}
        </Typography>
      )}

      {/* При ошибке бейдж молчит: «не найден» был бы неправдой — мы просто не знаем. */}
      {status.isError && (
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" color="danger">
            {t('credentials.loadError')}
          </Typography>
          <Button variant="secondary" size="sm" onClick={() => void status.refetch()}>
            {t('common.retry')}
          </Button>
        </Stack>
      )}

      {data && (
        <>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Badge tone={CREDENTIALS_TONE[data.source]} withDot>
              {t(`credentials.source_${data.source}`)}
            </Badge>
            {data.hasManual && (
              <Typography variant="mono" color="subtle" as="span" truncate>
                {data.manualPath}
              </Typography>
            )}
          </Stack>

          {data.reason && (
            <Typography variant="body-sm" color="warning">
              {data.reason}
            </Typography>
          )}

          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              leftIcon={<Icon name="lock" size={18} />}
              onClick={onSetManually}
            >
              {t('credentials.setManually')}
            </Button>
            {data.hasManual && (
              <Button
                variant="ghost"
                onClick={() => clear.mutate()}
                isLoading={clear.isPending}
                disabled={clear.isPending}
              >
                {t('credentials.clearManual')}
              </Button>
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}

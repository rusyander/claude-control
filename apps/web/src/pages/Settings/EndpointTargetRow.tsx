import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TruncatedText } from '@shared/ui/truncated-text';
import type { EndpointTargetRowProps } from './EndpointTargetRow.types';

/**
 * Одна строка списка «куда применить»: CLI, что именно в него будет записано и
 * кнопка записи. У неподдержанного CLI вместо кнопки — причина отказа своими
 * словами: «нельзя» без объяснения выглядит недоделкой, а причина здесь всегда
 * конкретная (переменной адреса у этого CLI не задокументировано, файла
 * переменных нет вовсе, вид API другой).
 */
export function EndpointTargetRow({
  target,
  disabled,
  isApplying,
  onApply,
}: EndpointTargetRowProps) {
  const { t } = useTranslation();

  return (
    <Card padding="sm">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" weight="medium" as="span">
              {target.providerName}
            </Typography>
            {target.supported ? (
              <Badge tone="success">{t('endpoints.targetReady')}</Badge>
            ) : (
              <Badge tone="neutral">{t('endpoints.targetSkipped')}</Badge>
            )}
          </Stack>

          {target.supported && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="check" size={16} />}
              onClick={() => onApply(target.providerId)}
              disabled={disabled}
              isLoading={isApplying}
            >
              {t('endpoints.apply')}
            </Button>
          )}
        </Stack>

        {target.supported ? (
          <Stack gap="var(--spacing-3xs)">
            {target.plan.map((item) => (
              <Typography key={item.key} variant="caption" color="subtle" as="div">
                <code>{item.key}</code>
                {' = '}
                {item.value || t('endpoints.planEmpty')}
                {item.secret ? ` (${t('endpoints.planSecret')})` : ''}
              </Typography>
            ))}
            <TruncatedText text={target.filePath} variant="caption" color="subtle" />
          </Stack>
        ) : (
          <Typography variant="caption" color="subtle">
            {t(`endpoints.reason.${target.reason ?? 'no_env_section'}`)}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}

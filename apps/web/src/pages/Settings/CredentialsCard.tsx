import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { useClearCredentials, useCredentialsStatus, CREDENTIALS_TONE } from '@entities/Credentials';
import { CredentialsFormModal } from '@features/CredentialsEditor';

/**
 * Доступ Claude Code к аккаунту.
 *
 * Нужен ровно одной вещи — песочнице: она запускает Claude с отдельным
 * каталогом конфигурации, и штатный доступ туда не попадает. Всё остальное
 * работает с настоящим каталогом и в этой карточке не нуждается.
 *
 * Карточка показывает источник и даёт две кнопки; сама форма — общая с
 * мастером первого запуска (features/CredentialsEditor): один образец JSON,
 * одна проверка, один текст предупреждения. Токен здесь не показывается
 * никогда: сервер отдаёт только источник.
 */
export function CredentialsCard() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const status = useCredentialsStatus();
  const clear = useClearCredentials();

  const source = status.data?.source ?? 'none';

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('credentials.title')}
          </Typography>
          {/* При ошибке запроса бейдж молчит: «не найден» там был бы неправдой —
              мы просто не знаем. */}
          {!status.isError && (
            <Badge tone={CREDENTIALS_TONE[source]} withDot>
              {t(`credentials.source_${source}`)}
            </Badge>
          )}
        </Stack>

        <Typography variant="caption" color="subtle" className="prose">
          {t('credentials.purpose')}
        </Typography>

        {status.isError && (
          <Typography variant="body-sm" color="danger" className="prose">
            {t('credentials.loadError')}
          </Typography>
        )}

        {status.data?.reason && (
          <Typography variant="body-sm" color="warning" className="prose">
            {status.data.reason}
          </Typography>
        )}

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="edit" size={20} />}
            onClick={() => setIsOpen(true)}
          >
            {t('credentials.setManually')}
          </Button>

          {status.data?.hasManual && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={20} />}
              onClick={() => clear.mutate()}
              isLoading={clear.isPending}
            >
              {t('credentials.clearManual')}
            </Button>
          )}
        </Stack>

        {status.data?.hasManual && (
          <Typography variant="caption" color="subtle">
            {t('credentials.manualFile')}: <code>{status.data.manualPath}</code>
          </Typography>
        )}
      </Stack>

      <CredentialsFormModal isOpen={isOpen} onOpenChange={setIsOpen} />
    </Card>
  );
}

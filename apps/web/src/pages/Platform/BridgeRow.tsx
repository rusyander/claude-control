import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { usePlatformBridge, useConnectPlatformBridge } from '@entities/Platform';

/**
 * Переходник MCP: те же агенты, знания и модели контура — локальному агенту как
 * инструменты.
 *
 * Стоит ОТДЕЛЬНО от карточек контуров, и это не мелочь вёрстки: запись в
 * конфигурации CLI одна на все контуры (её инструменты принимают идентификатор
 * контура параметром). Кнопка внутри карточки означала бы, что у каждого контура
 * свой переходник, — а нажатие на второй молча переключало бы первый.
 *
 * Ключ контура в конфигурацию CLI не уходит: переходник ходит в панель, а в
 * контур ходит уже она.
 */
export function BridgeRow() {
  const { t } = useTranslation();
  const bridge = usePlatformBridge();
  const connect = useConnectPlatformBridge();
  const blocked = bridge.data?.blockedReason;

  return (
    <Card padding="md">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" justify="between" wrap>
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h2">
            {t('platform.agentsBridgeTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.agentsBridgeText')}
          </Typography>
        </Stack>
        <Stack gap="var(--spacing-3xs)" align="end">
          <Button
            variant="secondary"
            onClick={() => connect.mutate(!bridge.data?.connected)}
            disabled={connect.isPending || bridge.isLoading || blocked !== undefined}
          >
            {bridge.data?.connected ? t('platform.agentsBridgeOff') : t('platform.agentsBridgeOn')}
          </Button>
          {/* Кнопка гаснет С ПРИЧИНОЙ: у активного CLI может не быть раздела
              MCP вовсе, и молча записать переходник в чужой файл — худшее из
              возможных «успешно». */}
          {blocked !== undefined && (
            <Typography variant="caption" color="warning">
              {t('platform.agentsBridgeBlocked', { reason: blocked })}
            </Typography>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

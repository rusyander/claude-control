import { useTranslation } from 'react-i18next';
import {
  usableVramGb,
  type HardwareGpu,
  type HardwareInfo,
} from '@agentdeck/contracts/local-models';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';

interface HardwareCardProps {
  hardware: HardwareInfo;
  onRefresh: () => void;
  isRefreshing: boolean;
}

/** Что панель узнала о машине — и каким способом, чтобы цифре можно было не верить вслепую. */
export function HardwareCard({ hardware, onRefresh, isRefreshing }: HardwareCardProps) {
  const { t } = useTranslation();
  const vramLine = (gpu: HardwareGpu): string => {
    if (gpu.unified) {
      return t('localModels.hardware.unified', {
        usable: Math.round(usableVramGb(gpu) * 10) / 10,
      });
    }
    if (gpu.freeGb === undefined)
      return t('localModels.hardware.vramNoFree', { total: gpu.vramGb });
    return t('localModels.hardware.vram', { total: gpu.vramGb, free: gpu.freeGb });
  };
  return (
    <Card padding="md" role="region" aria-label={t('localModels.hardware.title')}>
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="heading-sm" as="h2">
            {t('localModels.hardware.title')}
          </Typography>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="refresh" />}
            isLoading={isRefreshing}
            onClick={onRefresh}
          >
            {t('localModels.hardware.refresh')}
          </Button>
        </Stack>
        {hardware.gpus.length === 0 ? (
          <Typography variant="body-sm" color="warning">
            {t('localModels.hardware.noGpu')}
          </Typography>
        ) : (
          hardware.gpus.map((gpu, index) => (
            <Stack key={`${gpu.name}-${String(index)}`} gap="var(--spacing-2xs)">
              <Typography weight="semibold">{gpu.name}</Typography>
              <Typography variant="body-sm" color="muted">
                {vramLine(gpu)}
              </Typography>
              <Typography variant="body-sm" color="muted">
                {t(
                  gpu.bandwidthFrom === 'table'
                    ? 'localModels.hardware.bandwidth'
                    : 'localModels.hardware.bandwidthGuess',
                  { value: gpu.bandwidthGbs },
                )}
              </Typography>
            </Stack>
          ))
        )}
        <Typography variant="body-sm" color="muted">
          {[
            t('localModels.hardware.ram', { value: hardware.ramGb }),
            hardware.diskFreeGb === undefined
              ? ''
              : t('localModels.hardware.disk', { value: hardware.diskFreeGb }),
            t('localModels.hardware.detectedBy', { how: hardware.detectedBy }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      </Stack>
    </Card>
  );
}

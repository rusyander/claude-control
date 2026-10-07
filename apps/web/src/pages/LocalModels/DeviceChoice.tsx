import { useTranslation } from 'react-i18next';
import { localDevices, type LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import { placementOf, toGb, useSetLocalDevice } from '@entities/LocalModels';

/** Подпись места по доле в видеопамяти: целиком на карте, целиком на процессоре или пополам. */
function placeKey(percent: number): string {
  if (percent >= 99) return 'localModels.device.onGpu';
  if (percent <= 0) return 'localModels.device.onCpu';
  return 'localModels.device.split';
}

interface DeviceChoiceProps {
  info: LocalModelsInfo;
}

/**
 * Где считать модель: видеокарта по умолчанию, процессор — по выбору. И где она
 * легла НА ДЕЛЕ: по ответу сервера, а не по выбору, — выбор «процессор» Metal на
 * Mac исполнить не может, а модель, не влезшая в карту, тихо делится с процессором.
 */
export function DeviceChoice({ info }: DeviceChoiceProps) {
  const { t } = useTranslation();
  const setDevice = useSetLocalDevice();
  const { server } = info;
  const apple = info.hardware.gpus[0]?.unified === true;

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="heading-sm" as="h3">
        {t('localModels.device.title')}
      </Typography>
      <Typography variant="caption" color="muted">
        {t(apple ? 'localModels.device.whatApple' : 'localModels.device.what')}
      </Typography>
      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        {localDevices.map((device) => (
          <Button
            key={device}
            size="sm"
            variant={info.device === device ? 'primary' : 'secondary'}
            aria-pressed={info.device === device}
            isLoading={setDevice.isPending && setDevice.variables === device}
            disabled={setDevice.isPending}
            onClick={() => {
              if (device === info.device) return;
              setDevice.mutate(device, {
                onSuccess: () =>
                  toast.success(
                    t('localModels.device.switched', {
                      device: t(`localModels.device.${device}`),
                    }),
                  ),
              });
            }}
          >
            {t(`localModels.device.${device}`)}
          </Button>
        ))}
      </Stack>
      {server.running
        ? server.loaded.map((model) => {
            const { gpuShare } = placementOf(model);
            const percent = Math.round(gpuShare * 100);
            const size = toGb(model.sizeBytes || model.vramBytes);
            const where = t(placeKey(percent), { percent });
            const cpuIgnored = server.device === 'cpu' && percent > 0;
            const spilled = server.device === 'gpu' && percent < 99;
            return (
              <Stack key={model.tag} gap="var(--spacing-3xs)">
                <Typography variant="caption" color="muted">
                  {t('localModels.runtime.loaded', { tag: model.tag, size, where })}
                </Typography>
                {cpuIgnored ? (
                  <Typography variant="caption" color="warning">
                    {t('localModels.device.cpuIgnored', { size: toGb(model.vramBytes) })}
                  </Typography>
                ) : null}
                {spilled ? (
                  <Typography variant="caption" color="warning">
                    {t('localModels.device.spilled')}
                  </Typography>
                ) : null}
              </Stack>
            );
          })
        : null}
    </Stack>
  );
}

import { useTranslation } from 'react-i18next';
import type { Platform, PlatformSmokeTools } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { toast } from '@shared/lib/toast';
import { useSavePlatform } from '@entities/Platform';

interface SmokeToolsLineProps {
  platform: Platform;
  tools: PlatformSmokeTools;
}

/**
 * Итог пробы инструментов (развилка 3): вызывает ли модель инструмент полем.
 *
 * Строка отдельная от пробного запроса, потому что это другой вопрос: модель
 * может отвечать словами безупречно и при этом не уметь вызвать инструмент — и
 * тогда агент «работает», а файлы не меняются. Лечение одно и называется прямо
 * здесь кнопкой: прослойка везёт инструменты текстом протокола.
 *
 * Причина — ключом, а не текстом сервера: тот по-русски, а строка обязана
 * говорить на языке панели.
 *
 * Прослойка уже включена — строки нет: итог пробы остался от запуска без неё и
 * про нынешний путь ничего не говорит.
 */
export function SmokeToolsLine({ platform, tools }: SmokeToolsLineProps) {
  const { t } = useTranslation();
  const save = useSavePlatform();
  if (platform.toolShim) return null;

  if (tools.ok) {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <StatusDot tone="success" />
        <Typography variant="body-sm" color="muted">
          {t('platform.smokeToolsOk')}
        </Typography>
      </Stack>
    );
  }

  const enable = (): void => {
    save.mutate(
      { platform: { ...platform, toolShim: true } },
      { onError: () => toast.error(t('platform.enableShimFailed')) },
    );
  };

  return (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
      <StatusDot tone="warning" />
      <Typography variant="body-sm" style={{ flex: '1 1 16rem' }}>
        {t(`platform.smokeTools.${tools.reason ?? 'no-call'}`)}
      </Typography>
      <Button size="sm" variant="secondary" onClick={enable} disabled={save.isPending}>
        {t('platform.enableShim')}
      </Button>
    </Stack>
  );
}

import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { toast } from '@shared/lib/toast';
import { useIsPlatformSaving, useSavePlatform } from '@entities/Platform';
import type { SmokeToolsLineProps } from './SmokeToolsLine.types';
import { smokeToolsLineKind } from '../lib/smokeToolsLineKind';

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
 * Прослойку включила сама панель по этому же итогу (`toolShimFromProbe`) —
 * строка остаётся и меняет наклонение: не предложение, а отчёт о сделанном с
 * кнопкой обратно. Умолчание, о котором человек узнаёт по счёту за длинный ход,
 * — это не умолчание, а сюрприз.
 *
 * Прослойка включена человеком — строки нет: итог пробы остался от запуска без
 * неё и про нынешний путь ничего не говорит.
 */
export function SmokeToolsLine({ platform, tools }: SmokeToolsLineProps) {
  const { t } = useTranslation();
  const save = useSavePlatform({ silentError: true });
  // Любая запись контура, не только своя: щелчок собирает контур целиком.
  const saving = useIsPlatformSaving();

  const setShim = (toolShim: boolean): void => {
    save.mutate(
      { platform: { ...platform, toolShim } },
      {
        onError: () =>
          toast.error(t(toolShim ? 'platform.enableShimFailed' : 'platform.disableShimFailed')),
      },
    );
  };

  const kind = smokeToolsLineKind(platform, tools);
  if (kind === 'none') return null;

  if (kind === 'auto') {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <StatusDot tone="neutral" />
        <Typography variant="body-sm" style={{ flex: '1 1 16rem' }}>
          {t('platform.smokeToolsShimOn', {
            reason: t(`platform.smokeTools.${tools.reason ?? 'no-call'}`),
          })}
        </Typography>
        <Button size="sm" variant="secondary" onClick={() => setShim(false)} disabled={saving}>
          {t('platform.disableShim')}
        </Button>
      </Stack>
    );
  }

  if (kind === 'ok') {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <StatusDot tone="success" />
        <Typography variant="body-sm" color="muted">
          {t('platform.smokeToolsOk')}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
      <StatusDot tone="warning" />
      <Typography variant="body-sm" style={{ flex: '1 1 16rem' }}>
        {t(`platform.smokeTools.${tools.reason ?? 'no-call'}`)}
      </Typography>
      <Button size="sm" variant="secondary" onClick={() => setShim(true)} disabled={saving}>
        {t('platform.enableShim')}
      </Button>
    </Stack>
  );
}

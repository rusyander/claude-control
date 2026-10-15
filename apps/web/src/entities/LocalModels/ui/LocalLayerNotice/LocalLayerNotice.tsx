import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { useLocalActivity } from '../../api/useLocalActivity';
import { frozenToolsNotice, layerNotice } from '../../model/layerNotice';
import type { LocalLayerNoticeProps, LocalLayerWarningProps } from './LocalLayerNotice.types';

/**
 * Слой прогона не оставляет места разговору в окне сервера (L6, ревью B1): числа и одно
 * действие. Одна и та же строка — в чате (под ходом и между ходами) и на карточке сервера в
 * разделе «Локальные модели», чтобы человек узнал о ней до первого отказа или на нём.
 */
export function LocalLayerNotice({ layer, session, className }: LocalLayerNoticeProps) {
  const { t, i18n } = useTranslation();
  const view = layerNotice(layer);
  const frozen = frozenToolsNotice(layer, session);
  const number = (value: number): string => value.toLocaleString(i18n.language);
  const frozenLine = frozen ? (
    <Typography
      variant="body-sm"
      color="warning"
      role="status"
      aria-live="polite"
      data-testid="local-frozen-notice"
      {...(className ? { className } : {})}
    >
      {t('localModels.layer.frozen', { tokens: number(frozen.tokens) })}
    </Typography>
  ) : null;
  if (!view) return frozenLine;
  const fix = (): string => {
    if (view.fix.key === 'fixNone') return t('localModels.layer.fixNone');
    const context = number(view.fix.context);
    if (view.fix.key === 'fixQuant')
      return t('localModels.layer.fixQuant', { quant: view.fix.quant, context });
    return t('localModels.layer.fixContext', { context });
  };
  return (
    <>
      <Typography
        variant="body-sm"
        color="warning"
        role="status"
        aria-live="polite"
        data-testid="local-layer-notice"
        {...(className ? { className } : {})}
      >
        {t('localModels.layer.tooBig', {
          tokens: number(view.tokens),
          context: number(view.context),
          limit: number(view.limit),
        })}{' '}
        {fix()}
      </Typography>
      {frozenLine}
    </>
  );
}

/**
 * Та же строка между ходами чата на локальной модели: состояние сервера спрашивается один раз
 * (и при возврате на вкладку), без опроса — ход не идёт.
 */
export function LocalLayerWarning({ session, className }: LocalLayerWarningProps) {
  const activity = useLocalActivity(true, false);
  return (
    <LocalLayerNotice
      layer={activity.data?.layer}
      {...(session ? { session } : {})}
      {...(className ? { className } : {})}
    />
  );
}

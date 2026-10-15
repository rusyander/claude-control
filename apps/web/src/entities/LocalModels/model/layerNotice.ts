import type { LocalLayerFit } from '@agentdeck/contracts/local-models';

/** Чем починить слой, который не влезает в окно: ключ строки словаря и её числа. */
export type LayerFixView =
  | { key: 'fixContext'; context: number }
  | { key: 'fixQuant'; context: number; quant: string }
  | { key: 'fixNone' };

export interface LayerNoticeView {
  tokens: number;
  context: number;
  limit: number;
  fix: LayerFixView;
}

/**
 * Предупреждение о слое (L6, ревью B1): слой прогона не оставляет места разговору в окне
 * сервера — каждый ход получит отказ «Prompt is too long». Человек видит числа и ОДНО
 * действие: поднять окно, а если нынешнее квантование такое окно не вынесет — и квантование.
 * Влезает или замера нет — молчим.
 */
export function layerNotice(layer: LocalLayerFit | undefined): LayerNoticeView | undefined {
  if (!layer || layer.fits) return undefined;
  return { tokens: layer.tokens, context: layer.context, limit: layer.limit, fix: fixOf(layer) };
}

function fixOf(layer: LocalLayerFit): LayerFixView {
  if (!layer.fix) return { key: 'fixNone' };
  if (layer.fix.quant)
    return { key: 'fixQuant', context: layer.fix.context, quant: layer.fix.quant };
  return { key: 'fixContext', context: layer.fix.context };
}

/**
 * Описания MCP, замороженные разговором: начат до подгрузки по требованию, и Claude Code держит
 * его набор инструментов неизменным. Строка — только в том разговоре, чей запрос замерен:
 * замер один на модель, и в другом чате эта строка была бы неправдой.
 */
export function frozenToolsNotice(
  layer: LocalLayerFit | undefined,
  session: string | undefined,
): { tokens: number } | undefined {
  if (!layer?.frozenTools || !session || layer.session !== session) return undefined;
  return { tokens: layer.frozenTools };
}

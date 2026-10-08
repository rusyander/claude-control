import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import type { CardText } from './model.types';
import { cardPreview } from './cardPreview';

/** Сводка карточки на языке телефона: код — словарём, подстановки — стороной языка. */
export function cardSummary(pending: PanelPendingAction, text: CardText, language: string): string {
  const preview = cardPreview(pending, language);
  return text(preview.summaryCode, preview.summaryParams, preview.summary);
}

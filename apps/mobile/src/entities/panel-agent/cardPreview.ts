import type { PanelPendingAction, PanelActionPreview } from '@agentdeck/contracts/panel-agent';
import { previewInLanguage } from '@agentdeck/contracts/panel-agent';

/**
 * Предпросмотр на языке телефона: у английского — английские стороны
 * двуязычных данных, когда сервер их прислал (заголовки шагов в сводке, полях и
 * диффе); иначе как пришёл — так читаются и старые записи.
 */
export function cardPreview(pending: PanelPendingAction, language: string): PanelActionPreview {
  return previewInLanguage(pending.preview, language);
}

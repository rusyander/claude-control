import type { ClaudeLocation } from '@agentdeck/contracts';

export interface LocationView {
  /** Тон бейджа: красный — только когда без каталога не работает выбранный CLI. */
  tone: 'success' | 'danger' | 'neutral';
  /** Каталог Claude не нужен выбранному CLI — вместо «не найден» так и сказать. */
  claudeUnused: boolean;
  /** Строки о недостающих файлах и сбое каталога — только когда каталог в деле. */
  showProblems: boolean;
}

/**
 * Как показать каталог Claude на «Обзоре». Развилка A2 (07.10): при другом
 * провайдере отсутствующий `~/.claude` горел красным «не найден», хотя панель
 * работала — её данные лежат в `~/.agentdeck/data`, а Claude не используется.
 */
export function locationView(location: ClaudeLocation, claudeInUse: boolean): LocationView {
  if (location.isValid) return { tone: 'success', claudeUnused: false, showProblems: true };
  if (!claudeInUse) return { tone: 'neutral', claudeUnused: true, showProblems: false };
  return { tone: 'danger', claudeUnused: false, showProblems: true };
}

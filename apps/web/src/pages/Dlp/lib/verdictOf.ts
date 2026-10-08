import type { DlpPreviewResult } from '@agentdeck/contracts';
import type { BadgeTone } from '@shared/ui/badge';

/** Итог проверки одной строкой: отклонён, с заменами или чисто. */
export function verdictOf(result: DlpPreviewResult): { tone: BadgeTone; key: string } {
  if (result.blocked) return { tone: 'danger', key: 'dlp.previewBlocked' };
  if (result.hits.length > 0) return { tone: 'warning', key: 'dlp.previewMasked' };
  return { tone: 'success', key: 'dlp.previewClean' };
}

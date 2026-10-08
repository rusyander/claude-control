import type { TFunction } from 'i18next';
import type { PanelActionJournalEntry } from '@agentdeck/contracts/panel-agent';
import { isPanelTextCode } from '@agentdeck/contracts/panel-agent';
import { panelText } from './panelText';

/**
 * Строка следа: название кодом и факты исхода через «—». Записи без кода
 * (сделанные до кодов) показываются русским текстом сервера, как записаны.
 */
export function journalSummary(
  t: TFunction,
  entry: Pick<PanelActionJournalEntry, 'summary' | 'summaryCode' | 'summaryFacts'>,
): string {
  if (!entry.summaryCode || !isPanelTextCode(entry.summaryCode)) return entry.summary;
  const title = panelText(t, entry.summaryCode, undefined, entry.summary);
  const facts = (entry.summaryFacts ?? [])
    .filter(isPanelTextCode)
    .map((fact) => t(`panelAgent.text.${fact}`));
  return facts.length > 0 ? `${title} — ${facts.join(', ')}` : title;
}

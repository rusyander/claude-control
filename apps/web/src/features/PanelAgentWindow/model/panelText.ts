import type { TFunction } from 'i18next';
import {
  isPanelTextCode,
  type PanelActionJournalEntry,
  type PanelTextParams,
} from '@agentdeck/contracts/panel-agent';

/**
 * Текст карточки или следа на языке окна: код сервера — своим словарём,
 * без кода (старая запись следа, новый код у старого окна) — русская строка
 * сервера как есть. Значение-данные (путь, промпт) кода не несёт и не
 * переводится.
 */
export function panelText(
  t: TFunction,
  code: string | undefined,
  params: PanelTextParams | undefined,
  fallback: string,
): string {
  if (!code || !isPanelTextCode(code)) return fallback;
  return t(`panelAgent.text.${code}`, { ...params });
}

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

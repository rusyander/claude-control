import type { SessionLocation } from '@agentdeck/contracts';
import type { TFunction } from 'i18next';

/** Подпись места: редактор (с именем), терминал или «не опознан». */
export function hostLabel(location: SessionLocation, t: TFunction): string {
  const { where } = location;
  if (where.kind !== 'process') return t('analytics.sessionStopNothing');
  if (where.host === 'terminal') return t('analytics.sessionWhereTerminal');
  return where.editor
    ? t('analytics.sessionWhereEditor', { editor: where.editor })
    : t('analytics.sessionWhereEditorUnknown');
}

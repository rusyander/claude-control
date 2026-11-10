import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { Badge } from '@shared/ui/badge';
import { reasonKeys } from './relatedMerge.lib';

interface RelatedHintProps {
  card: Pick<BoardCard, 'related'>;
}

/**
 * Значок «связано: N» на плитке карточки (D26): у записи «Входящих» есть связанные записи —
 * общий эпик, связь задач, общий путь. Только подсказка: объединяет человек в окне карточки.
 * Плитка — сама кнопка, поэтому значок не интерактивен; список — в подсказке и в окне.
 */
export function RelatedHint({ card }: RelatedHintProps) {
  const { t } = useTranslation();
  const related = card.related ?? [];
  if (related.length === 0) return null;
  const list = related
    .map((h) => {
      const why = reasonKeys(h.reasons)
        .map((r) => t(`coreBoard.related.reason.${r}`))
        .join(', ');
      return `${h.title} (${why})`;
    })
    .join('; ');
  return (
    <span title={t('coreBoard.related.hintTitle', { list })} data-board-related={related.length}>
      <Badge tone="accent">{t('coreBoard.related.hint', { count: related.length })}</Badge>
    </span>
  );
}

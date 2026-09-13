import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scanSplitBlocks } from '@agentdeck/contracts/task-split';
import { scanHandoffBlocks } from '@agentdeck/contracts/chat-handoff';
import { scanMediaBlocks } from '@agentdeck/contracts/media-block';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { TokenBadge } from '@shared/ui/token-badge';
import { TaskSplitCard } from './TaskSplitCard';
import { HandoffCard } from './HandoffCard';
import { MediaFeedCard } from './MediaFeedCard';
import type { StreamedAnswerProps } from './StreamedAnswer.types';
import styles from './ChatMessages.module.scss';

/**
 * Ответ, который печатается прямо сейчас.
 *
 * Живёт отдельным компонентом потому, что это единственное место ленты, которое
 * пересчитывается на КАЖДОЕ слово: все разборы блоков идут по растущему тексту, и
 * держать их в самой ленте значило бы гонять её целиком на каждый кусок.
 *
 * Блоки прячем из показа уже здесь, пока ответ идёт: иначе в ленте несколько
 * секунд стоял бы голый JSON или разметка SVG, а незакрытый блок показывался бы
 * обрубком. Карточки рисуем сразу, но погашенными — решать и собирать файлы можно,
 * когда агент договорит, и это ровно то, что видно.
 */
export function StreamedAnswer({ stream, splitCeiling, costUnit, effort }: StreamedAnswerProps) {
  const { t } = useTranslation();

  // Разборы идут цепочкой по одному и тому же тексту — языки блоков разные, и
  // каждый скан видит только свой.
  const split = useMemo(() => scanSplitBlocks(stream.text), [stream.text]);
  const handoff = useMemo(() => scanHandoffBlocks(split.text), [split.text]);
  // Здесь — и только здесь — разбор знает, что ответ ещё идёт: незакрытый блок
  // прячется вместе с хвостом, иначе в ленте секундами стоит простыня JSON.
  const media = useMemo(() => scanMediaBlocks(handoff.text, { streaming: true }), [handoff.text]);

  if (!stream.text) return null;

  return (
    <div className={styles.block}>
      <div className={styles.blockBody}>
        {media.text && (
          <div
            className={styles.text}
            // Разметку строит markdown-it с выключенным сырым html.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(media.text) }}
          />
        )}
        {split.proposals.map((proposal, index) => (
          <TaskSplitCard key={index} proposal={proposal} ceiling={splitCeiling} disabled />
        ))}
        {split.rejected > 0 && (
          <div className={styles.splitRejected} role="status">
            {t('chat.split.notParsed')}
          </div>
        )}
        {handoff.proposals.map((proposal, index) => (
          <HandoffCard key={index} proposal={proposal} disabled />
        ))}
        {handoff.rejected > 0 && (
          <div className={styles.splitRejected} role="status">
            {t('chat.handoff.notParsed')}
          </div>
        )}
        {/* Готовый блок виден сразу, но собирать по нему файлы рано: реплики ещё
            нет, а запись на диск по черновику оставила бы лишнюю копию. Рисунок
            при этом уже показан. */}
        {media.pictures.map((svg, index) => (
          <MediaFeedCard key={`svg-${index}`} svg={svg} disabled />
        ))}
        {media.decks.map((deck, index) => (
          <MediaFeedCard key={`deck-${index}`} deck={deck} disabled />
        ))}
      </div>
      {stream.textUsage && (
        <TokenBadge
          usage={stream.textUsage}
          unit={costUnit}
          effort={effort}
          label={t('chat.usage.answer')}
          className={styles.spend}
        />
      )}
    </div>
  );
}

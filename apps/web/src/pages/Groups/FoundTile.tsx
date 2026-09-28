import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { sourceLabel } from './model/sections';
import { foundText } from './model/foundText';
import { TILE_PREVIEW_STEPS } from './model/tile';
import { TileFrame } from './TileFrame';
import { TileFacts } from './TileFacts';
import type { FoundTileProps } from './FoundTile.types';

/**
 * Находка обнаружения в сетке: имя, «Когда», где найдена, первые шаги, состав
 * по видам и числа — тем же устройством, что у карточки группы.
 */
export function FoundTile({ found, onOpen }: FoundTileProps) {
  const { t, i18n } = useTranslation();
  const text = foundText(found, i18n.language);
  const source = sourceLabel(found.foundIn);
  const where =
    source.kind === 'provider'
      ? t('groupSources.providerSource', { name: source.name })
      : source.name;
  const titles = found.steps.map((step) => step.title.trim()).filter(Boolean);

  return (
    <TileFrame
      name={text.name}
      onOpen={onOpen}
      whenLabel={t('groupSources.when')}
      when={text.when}
      whenEmpty={t('groupSources.whenEmpty')}
      counts={`${t('groupSources.stepsCount', { count: found.steps.length })} · ${t('groups.membersCount', { count: found.members.length })}`}
      badges={
        <>
          <Badge tone="warning">{t('groupSources.foundBadge')}</Badge>
          <Badge tone="neutral">{t('groupSources.foundSourceBadge', { source: where })}</Badge>
        </>
      }
    >
      <TileFacts
        steps={titles.slice(0, TILE_PREVIEW_STEPS)}
        moreSteps={Math.max(0, titles.length - TILE_PREVIEW_STEPS)}
        noStepsText={t('groupSources.stepsEmpty')}
        members={found.members}
      />
    </TileFrame>
  );
}

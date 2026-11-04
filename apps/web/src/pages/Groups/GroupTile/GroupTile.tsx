import { useTranslation } from 'react-i18next';
import { isBuiltinGroupId, scopeOf } from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TileFacts } from '../TileFacts/TileFacts';
import { TileFrame } from '../TileFrame/TileFrame';
import type { GroupTileProps } from './GroupTile.types';
import { scopeLabel } from '../lib/scopeLabel';
import { tileStepTitles } from '../model/tileStepTitles';

/**
 * Карточка прежней группы — только для чтения (этап 10, F1): имя, «Когда», область, первые шаги
 * словами, состав по видам и единственное действие «В ядро» — перевод её «Пути» в сценарий ядра.
 * Ни тумблера, ни копии, ни окна правки: прежний исполнитель групп снят, группы ведёт ядро.
 */
export function GroupTile({ group, pair, onCore }: GroupTileProps) {
  const { t, i18n } = useTranslation();
  const scope = scopeOf(group);
  const when = group.when ?? group.scenario?.when ?? '';
  const isScenario = group.flow === 'scenario';
  const preview = tileStepTitles(group, i18n.language);
  const stepCount = preview.titles.length + preview.more;
  const members = t('groups.membersCount', { count: group.members.length });
  const steps = stepCount > 0 ? t('groupSources.stepsCount', { count: stepCount }) : undefined;

  return (
    <TileFrame
      anchor={group.id}
      anchorAlias={pair?.id}
      name={group.name}
      whenLabel={t('groupSources.when')}
      when={when}
      whenEmpty={t('groupSources.whenEmpty')}
      counts={steps ? `${steps} · ${members}` : members}
      badges={
        <>
          <Badge tone={scope.kind === 'project' ? 'info' : 'accent'}>{scopeLabel(t, scope)}</Badge>
          {isScenario && <Badge tone="accent">{t('groupsPage.tile.scenarioBadge')}</Badge>}
          {isBuiltinGroupId(group.id) && (
            <Badge tone="neutral">{t('groupsPage.tile.builtinBadge')}</Badge>
          )}
          {pair && <Badge tone="info">{t('groupSources.pairBadge')}</Badge>}
        </>
      }
      aside={
        // Переводить нечего — кнопки нет: пустой сценарий ядро всё равно не примет.
        onCore && stepCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="play" size={16} />}
            aria-label={t('groupsPage.core.tileImportAria', { name: group.name })}
            title={t('groupsPage.core.tileImportAria', { name: group.name })}
            onClick={() => onCore(group)}
            data-group-core-import
          >
            {t('groupsPage.core.tileImport')}
          </Button>
        ) : undefined
      }
    >
      <TileFacts
        steps={preview.titles}
        moreSteps={preview.more}
        noStepsText={t(isScenario ? 'groupsPage.tile.noStepsScenario' : 'groupsPage.tile.noSteps')}
        members={group.members}
        pinned={Object.keys(group.knobs ?? {}).length}
        projects={group.projectPaths}
      />
    </TileFrame>
  );
}

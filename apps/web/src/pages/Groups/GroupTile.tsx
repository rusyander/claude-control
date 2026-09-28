import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { isForeignGlobal, scopeOf, scopeProvider, type GroupScope } from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ownStepCount } from '@features/GroupPath';
import { useGroupMembers, useGroupPath, useSetGroupEnabled } from '@entities/Group';
import { describedStepTitle, previewSteps, projectOnlyLines, type StepPreview } from './model/tile';
import { TileFacts } from './TileFacts';
import { usePairSide } from './model/usePairSide';
import { TileFrame } from './TileFrame';
import type { GroupTileProps } from './GroupTile.types';

/**
 * Карточка группы в сетке: имя, «Когда», область, пара, первые шаги словами,
 * состав по видам, закреплённые числа, проекты, тумблер и предупреждение «в
 * проекте изменилось», кнопка «Копировать». Остальное — в окне группы по щелчку. У пары всё — той
 * стороны, что действует в проекте.
 */
export function GroupTile({ group, pair, onOpen, onCopy }: GroupTileProps) {
  const { t, i18n } = useTranslation();
  const setGroupEnabled = useSetGroupEnabled();
  const side = usePairSide(group, pair);
  const { shown } = side;
  const path = useGroupPath(shown.id);
  const scope = scopeOf(group);
  const when = shown.when ?? shown.scenario?.when ?? '';
  const changed = group.originChanged ?? [];
  const isScenario = shown.flow === 'scenario';
  // Названия шагов скиллов — из описаний состава (тот же запрос, что у окна группы).
  const described = useGroupMembers(shown.id);
  // Состав не прочитался — ждать слов нечего: оригинальные названия лучше пустой карточки.
  const stepTitle = described.isError
    ? undefined
    : describedStepTitle(described.data, i18n.language);
  const preview = path.data
    ? previewSteps(path.data.entries, i18n.language, undefined, stepTitle)
    : undefined;

  const members = t('groups.membersCount', { count: shown.members.length });
  // Участник без файла — видно на карточке: прежде о нём знал только «Состав».
  // Файл в .claude привязанного проекта — не «нет файла», а «только в проекте».
  const missingBriefs = (described.data?.members ?? []).filter((member) => member.missing);
  const missing = missingBriefs.filter((member) => !member.foundIn).map((member) => member.id);
  const onlyInProject = projectOnlyLines(missingBriefs, (project, names, count) =>
    t('groupSources.membersOnlyInProject', { count, project, names }),
  );
  // Путь не прочитался — число шагов молча опускаем: сбой назовёт окно группы,
  // а «читаю…» навсегда на карточке соврало бы.
  let steps: string | undefined = t('groupSources.stepsCountLoading');
  // Ноль шагов не повторяем в числах: тело карточки уже сказало «Своих шагов нет».
  if (path.data) {
    const count = ownStepCount(path.data.entries);
    steps = count > 0 ? t('groupSources.stepsCount', { count }) : undefined;
  } else if (path.isError) steps = undefined;

  return (
    <TileFrame
      anchor={group.id}
      anchorAlias={pair?.id}
      name={group.name}
      onOpen={onOpen}
      whenLabel={t('groupSources.when')}
      when={when}
      whenEmpty={t('groupSources.whenEmpty')}
      counts={steps ? `${steps} · ${members}` : members}
      warnings={[
        // Выбор стороны пары не прочитался — карточка показывает глобальную
        // сторону наугад; молчать об этом значило бы выдать догадку за факт.
        pair && side.isError ? t('groupSources.choiceLoadError') : '',
        changed.length > 0 ? t('groupSources.originChangedCount', { count: changed.length }) : '',
        missing.length > 0
          ? t('groupSources.membersMissingCount', {
              count: missing.length,
              names: missing.join(', '),
            })
          : '',
        ...onlyInProject,
      ].filter(Boolean)}
      badges={
        <>
          <Badge tone={scope.kind === 'project' ? 'info' : 'accent'}>{scopeLabel(t, scope)}</Badge>
          {isScenario && <Badge tone="accent">{t('groupsPage.tile.scenarioBadge')}</Badge>}
          {pair && <Badge tone="info">{t('groupSources.pairBadge')}</Badge>}
          {!group.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
        </>
      }
      aside={
        <>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="copy" size={16} />}
            aria-label={t('groupsPage.copy.tileAria', { name: group.name })}
            title={t('groupsPage.copy.tileAria', { name: group.name })}
            onClick={onCopy}
          />
          {/* Копия для другой CLI держит файлы той CLI: тумблер панели двигает
              только сущности Claude, и здесь он ничего бы не включил. */}
          {!isForeignGlobal(group.scope) && (
            <Toggle
              checked={group.isEnabled}
              onCheckedChange={(isEnabled) => setGroupEnabled.mutate({ id: group.id, isEnabled })}
              disabled={setGroupEnabled.isPending}
              aria-label={`${t('common.enabled')}: ${group.name}`}
            />
          )}
        </>
      }
    >
      <TileFacts
        steps={tileSteps(preview)}
        stepsFailed={path.isError}
        moreSteps={preview?.more}
        noStepsText={t(isScenario ? 'groupsPage.tile.noStepsScenario' : 'groupsPage.tile.noSteps')}
        members={shown.members}
        pinned={Object.keys(shown.knobs ?? {}).length}
        projects={shown.projectPaths}
      />
    </TileFrame>
  );
}

/**
 * Шаги для карточки: `undefined` — «читаю…». Названия всех шагов ещё пишутся —
 * тоже «читаю…», а не «своих шагов нет». Сбой пути карточка называет отдельно
 * (`stepsFailed`): прежде он рисовался фактом «своих шагов нет».
 */
/** Метка области: проектная и копия для другой CLI называют провайдера. */
function scopeLabel(t: TFunction, scope: GroupScope): string {
  if (scope.kind === 'project') {
    return t('groupSources.scopeProjectProvider', { provider: scope.provider });
  }
  return isForeignGlobal(scope)
    ? t('groupSources.scopeGlobalProvider', { provider: scopeProvider(scope) })
    : t('groupSources.scopeGlobal');
}

function tileSteps(preview: StepPreview | undefined): string[] | undefined {
  if (!preview) return undefined;
  if (preview.titles.length === 0 && preview.waiting > 0) return undefined;
  return preview.titles;
}

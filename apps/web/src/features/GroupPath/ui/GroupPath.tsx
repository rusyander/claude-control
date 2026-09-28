import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  knobId,
  scopeOf,
  type KnobView,
  type PathEntry,
  type PathStep,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import {
  useGroupKnobs,
  useGroupPath,
  useSaveGroupPathSteps,
  useSetGroupKnobs,
} from '@entities/Group';
import { customSteps, moveToSlot, removeStep } from '../model/pathEdit';
import { buildPathRows, canInsertAfter, type PathRow } from '../model/pathRows';
import { inProject, rowText } from '../model/describe';
import { usePathContext } from '../model/usePathContext';
import { useEntryTitle } from '../model/useEntryTitle';
import {
  buildLayout,
  dropSlots,
  matchesFilter,
  numberedRows,
  type NumberedRow,
} from '../model/layout';
import { useStepDrag } from '../model/useStepDrag';
import { PathEntryRow } from './PathEntryRow';
import { PathAddSlot } from './PathAddSlot';
import { PathStage } from './PathStage';
import { PathToolbar } from './PathToolbar';
import { SkillBlock } from './SkillBlock';
import { StepComposer } from './StepComposer';
import { StepDetailModal } from './StepDetailModal';
import type { ComposerTarget } from './StepComposer.types';
import type { GroupPathProps } from './GroupPath.types';
import styles from './GroupPath.module.scss';

/**
 * «Порядок работы» — конструктор обоих видов группы. У конвейера стадии —
 * тонкие разделители, шаги скиллов собраны в сворачиваемые блоки, свои шаги
 * стоят между ними; у сценария — только шаги по порядку. «+» между любыми
 * двумя строками вставляет шаг, ручка переносит свой шаг (мышью, пальцем,
 * с клавиатуры), щелчок открывает окно шага на двух языках. Для длинного пути
 * — поиск, свёрнутые блоки и прилипшая панель.
 *
 * Порядок собирает сервер; клиент только переводит жест в новый список своих
 * шагов и отправляет его одним запросом — после ответа путь рисуется заново.
 */
export function GroupPath({ group, startComposer }: GroupPathProps) {
  const { t } = useTranslation();
  const path = useGroupPath(group.id);
  const knobs = useGroupKnobs(group.id);
  const save = useSaveGroupPathSteps(group.id);
  const setKnobs = useSetGroupKnobs(group.id);
  const titleOf = useEntryTitle();
  const context = usePathContext(group);
  const isScenario = group.flow === 'scenario';
  const [target, setTarget] = useState<ComposerTarget | undefined>(() =>
    startComposer ? { kind: 'insert', index: -1 } : undefined,
  );
  const [removing, setRemoving] = useState<PathStep | undefined>(undefined);
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const entries = path.data?.entries ?? [];
  const rows = buildPathRows(entries, knobs.data?.knobs ?? [], (id) => context.known.get(id)?.body);
  const layout = buildLayout(rows, group.flow);
  const slots = dropSlots(layout, rows, entries, collapsed);
  const drag = useStepDrag({
    slots,
    titleAt: (index) => (entries[index] ? titleOf(entries[index]) : ''),
    onDrop: (id, afterIndex) => save.mutate(moveToSlot(entries, id, afterIndex)),
    isBusy: save.isPending,
  });

  if (path.isLoading) return <SkeletonList rows={6} />;
  if (path.isError || !path.data) {
    return <LoadErrorCard title={t('groupPath.loadError')} onRetry={() => void path.refetch()} />;
  }

  const steps = customSteps(entries);
  const pending = knobs.data?.pending ?? [];
  const failed = knobs.data?.failed ?? [];
  const numbered = numberedRows(layout);
  const isFiltered = query.trim().length > 0;
  const visible = isFiltered
    ? numbered.filter(({ row }) => {
        const words = context.wordsOf(row);
        return matchesFilter(query, [words.title, words.line, words.hint]);
      })
    : numbered;
  const blockIds = layout.flatMap((item) => (item.kind === 'block' ? [item.skillId] : []));
  const isAllOpen = blockIds.every((id) => !collapsed.has(id));
  const opened = rows.find((row) => row.key === openKey);

  const setKnob = (knob: KnobView, value: number | null): void =>
    setKnobs.mutate({ [knobId(knob)]: value });

  const knobsText = (skillId: string): string => {
    if (knobs.isLoading || pending.includes(skillId)) return t('groupBuilder.block.knobsReading');
    if (failed.includes(skillId)) return t('groupBuilder.block.knobsFailed');
    const count = (knobs.data?.knobs ?? []).filter((knob) => knob.skillId === skillId).length;
    return count > 0
      ? t('groupBuilder.block.knobsCount', { count })
      : t('groupBuilder.block.knobsNone');
  };

  const toggleBlock = (skillId: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });

  const renderRow = ({ row, number }: NumberedRow) => {
    const words = context.wordsOf(row);
    const text = inProject(
      rowText(row, context.known, context.language),
      context.sourceOf(row).project,
    );
    const step = customStep(row);
    const referenced = step?.resource?.type === 'skill' ? step.resource.id : undefined;
    return (
      <PathEntryRow
        key={row.key}
        row={row}
        number={number}
        words={words}
        type={context.typeOf(row)}
        fallback={!words.hint && text.kind === 'summary' ? text : undefined}
        knobsNote={referenced && row.knobs.length === 0 ? knobsText(referenced) : undefined}
        isKnobSaving={setKnobs.isPending}
        isDragging={Boolean(step && drag.drag?.stepId === step.id)}
        // Ручка не исчезает на время сохранения: снятая кнопка уносила фокус,
        // и второй перенос с клавиатуры шёл в никуда (занятость — aria-disabled).
        dragHandle={
          step && !isFiltered ? drag.handleProps(step.id, row.entryIndex, words.title) : undefined
        }
        onOpen={() => setOpenKey(row.key)}
        onKnob={setKnob}
        onEdit={(edited) => setTarget({ kind: 'edit', step: edited })}
        onRemove={setRemoving}
      />
    );
  };

  const renderSlot = (index: number, row: PathRow) => {
    if (isFiltered || !canInsertAfter(rows, index)) return null;
    return (
      <PathAddSlot
        key={`slot:${row.key}`}
        afterIndex={row.entryIndex}
        label={t('groupPath.addAfter', { title: context.wordsOf(row).title })}
        isDropping={Boolean(drag.drag)}
        isDropTarget={drag.drag?.target === row.entryIndex}
        onAdd={() => setTarget({ kind: 'insert', index: row.entryIndex })}
      />
    );
  };

  const renderLayout = () =>
    layout.map((item) => {
      if (item.kind === 'stage') {
        const words = context.wordsOf(item.row);
        return (
          <Fragment key={item.row.key}>
            <PathStage
              title={words.title}
              hint={words.hint}
              onOpen={() => setOpenKey(item.row.key)}
            />
            {renderSlot(item.index, item.row)}
          </Fragment>
        );
      }
      if (item.kind === 'row') {
        return (
          <Fragment key={item.item.row.key}>
            {renderRow(item.item)}
            {renderSlot(item.item.index, item.item.row)}
          </Fragment>
        );
      }
      const last = item.items[item.items.length - 1];
      const first = item.items[0];
      if (!last || !first) return null;
      return (
        <Fragment key={`block:${item.skillId}:${first.index}`}>
          <SkillBlock
            title={context.skillTitle(item.skillId)}
            type={context.blockTypeOf(item.skillId)}
            count={item.items.length}
            knobsText={knobsText(item.skillId)}
            isOpen={!collapsed.has(item.skillId)}
            onToggle={() => toggleBlock(item.skillId)}
          >
            {item.items.map((numberedRow, position) => (
              <Fragment key={numberedRow.row.key}>
                {renderRow(numberedRow)}
                {position < item.items.length - 1 && renderSlot(numberedRow.index, numberedRow.row)}
              </Fragment>
            ))}
          </SkillBlock>
          {renderSlot(last.index, last.row)}
        </Fragment>
      );
    });

  return (
    <Stack gap="var(--spacing-xs)">
      <Typography variant="body-sm" color="subtle" className={styles.intro}>
        {isScenario ? t('groupBuilder.intro.scenario') : t('groupBuilder.intro.conveyor')}
      </Typography>

      {/* Выписка чисел идёт моделью — о ней говорим вслух, а не крутим скелет. */}
      <div role="status" aria-live="polite">
        {pending.length > 0 && (
          <Typography variant="caption" color="muted" className={styles.pending}>
            {t('groupKnobs.pending', { skills: pending.join(', ') })}
          </Typography>
        )}
        {failed.length > 0 && (
          <Typography variant="caption" color="muted" className={styles.pending}>
            {t('groupKnobs.failed', { skills: failed.join(', ') })}
          </Typography>
        )}
      </div>
      {(path.data?.unreadable ?? []).length > 0 && (
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap role="alert">
          <Typography variant="caption" color="danger">
            {t('groupPath.unreadable', { skills: (path.data?.unreadable ?? []).join(', ') })}
          </Typography>
          <Button size="sm" variant="ghost" onClick={() => void path.refetch()}>
            {t('groupPath.reread')}
          </Button>
        </Stack>
      )}
      {knobs.isError && (
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="caption" color="danger">
            {t('groupKnobs.loadError')}
          </Typography>
          <Button size="sm" variant="ghost" onClick={() => void knobs.refetch()}>
            {t('common.retry')}
          </Button>
        </Stack>
      )}

      <PathToolbar
        query={query}
        onQuery={setQuery}
        total={numbered.length}
        shown={visible.length}
        hasBlocks={blockIds.length > 0}
        isAllOpen={isAllOpen}
        onToggleAll={() => setCollapsed(isAllOpen ? new Set(blockIds) : new Set())}
        isEmpty={entries.length === 0}
        onAdd={() => setTarget({ kind: 'insert', index: entries.length - 1 })}
        announcement={drag.announcement}
      />

      {entries.length === 0 && (
        <Typography variant="body-sm" color="subtle">
          {t('groupBuilder.emptyScenario')}
        </Typography>
      )}
      {isFiltered && visible.length === 0 && (
        <Typography variant="body-sm" color="subtle">
          {t('groupBuilder.noMatch')}
        </Typography>
      )}

      <ol ref={drag.listRef} className={styles.list} aria-label={t('groupPath.listLabel')}>
        {isFiltered ? (
          visible.map(renderRow)
        ) : (
          <>
            {slots[0] === -1 && (
              <PathAddSlot
                afterIndex={-1}
                label={t('groupBuilder.addFirstSlot')}
                isDropping={Boolean(drag.drag)}
                isDropTarget={drag.drag?.target === -1}
                onAdd={() => setTarget({ kind: 'insert', index: -1 })}
              />
            )}
            {renderLayout()}
          </>
        )}
      </ol>

      {opened && (
        <StepDetailModal
          row={opened}
          title={context.wordsOf(opened).title}
          source={context.sourceOf(opened)}
          text={inProject(
            rowText(opened, context.known, context.language),
            context.sourceOf(opened).project,
          )}
          bilingual={context.bilingualOf(opened)}
          file={context.fileOf(context.sourceOf(opened))}
          isKnobSaving={setKnobs.isPending}
          onKnob={setKnob}
          // Окно шага остаётся под правкой: после «Подтвердить» человек видит, что сохранилось.
          onEdit={(step) => setTarget({ kind: 'edit', step })}
          onClose={() => setOpenKey(undefined)}
        />
      )}

      {target && (
        <StepComposer
          group={group}
          projectPath={projectPathOf(group)}
          entries={entries}
          target={target}
          onClose={() => setTarget(undefined)}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t('groupPath.removeTitle', { title: removing ? titleOf(asEntry(removing)) : '' })}
        description={t('groupPath.removeText')}
        confirmLabel={t('groupPath.removeConfirm')}
        isPending={save.isPending}
        onConfirm={() => {
          if (!removing) return;
          save.mutate(removeStep(steps, removing.id), { onSuccess: () => setRemoving(undefined) });
        }}
      />
    </Stack>
  );
}

function customStep(row: PathRow): PathStep | undefined {
  return row.kind === 'entry' && row.entry.kind === 'custom' ? row.entry.step : undefined;
}

function asEntry(step: PathStep): PathEntry {
  return { kind: 'custom', step };
}

function projectPathOf(group: GroupPathProps['group']): string | undefined {
  const scope = scopeOf(group);
  return scope.kind === 'project' ? scope.path : undefined;
}

import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { DragHandle, PathAddSlot, StepPathList, useStepDrag } from '@entities/StepPath';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { StepListProps } from './StepList.types';
import styles from './StepList.module.scss';

/**
 * Шаги черновика списком — те же места «+», ручка и перенос, что у «Порядка работы» групп
 * (`entities/StepPath`): шаг кладут мышью, пальцем или с клавиатуры, каждое движение звучит
 * в живой области. Щелчок по шагу открывает его форму справа.
 */
export function StepList({
  steps,
  selected,
  isBusy,
  onSelect,
  onInsert,
  onMove,
  onRemove,
}: StepListProps) {
  const { t } = useTranslation();
  // Каждый шаг можно положить в начало или после любого: цепочка без встроенных стадий.
  const slots = [-1, ...steps.map((_, index) => index)];
  const drag = useStepDrag({
    slots,
    titleAt: (index) => steps[index]?.title ?? '',
    onDrop: (stepId, afterIndex) => {
      const from = steps.findIndex((step) => step.id === stepId);
      if (from >= 0) onMove(from, afterIndex);
    },
    isBusy,
  });
  const isLast = steps.length <= 1;

  return (
    <>
      <span className={styles.live} role="status" aria-live="polite">
        {drag.announcement}
      </span>
      <StepPathList listRef={drag.listRef} label={t('coreScenario.editor.stepsLabel')}>
        <PathAddSlot
          afterIndex={-1}
          label={t('coreScenario.editor.addFirst')}
          isDropping={Boolean(drag.drag)}
          isDropTarget={drag.drag?.target === -1}
          onAdd={() => onInsert(-1)}
        />
        {steps.map((step, index) => {
          const title = step.title || step.id;
          const rowClass = [
            styles.row,
            index === selected ? styles.selected : '',
            drag.drag?.stepId === step.id ? styles.dragging : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <Fragment key={`${index}:${step.id}`}>
              <li className={rowClass} data-step-row={step.id}>
                <DragHandle title={title} handle={drag.handleProps(step.id, index, title)} />
                <span className={styles.number}>{index + 1}</span>
                <button
                  type="button"
                  className={styles.open}
                  aria-label={t('coreScenario.editor.open', { title })}
                  aria-pressed={index === selected}
                  onClick={() => onSelect(index)}
                >
                  <span className={styles.title}>{title}</span>
                  <span className={styles.meta}>{step.id}</span>
                </button>
                <Badge tone="neutral">{t(`coreScenario.kind.${step.kind}`)}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size={14} />}
                  aria-label={t('coreScenario.editor.remove', { title })}
                  title={isLast ? t('coreScenario.editor.lastStep') : undefined}
                  disabled={isLast || isBusy}
                  onClick={() => onRemove(index)}
                />
              </li>
              <PathAddSlot
                afterIndex={index}
                label={t('coreScenario.editor.addAfter', { title })}
                isDropping={Boolean(drag.drag)}
                isDropTarget={drag.drag?.target === index}
                onAdd={() => onInsert(index)}
              />
            </Fragment>
          );
        })}
      </StepPathList>
    </>
  );
}

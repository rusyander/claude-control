import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knobId } from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { pickLang } from '../model/useEntryTitle';
import { KnobSelect } from './KnobSelect';
import { RowTextView } from './RowTextView';
import { StepHint } from './StepHint';
import { TypeChip } from './TypeChip';
import type { PathEntryRowProps, RowHintProps } from './PathEntryRow.types';
import styles from './PathEntryRow.module.scss';

/**
 * Строка конструктора — компактная, чтобы восемьдесят шагов читались одним
 * экраном: номер, название на языке интерфейса и вид шага — одна кнопка (она
 * открывает окно шага, наведение или фокус показывают подсказку), под ней одна
 * строка «что делает». Числа шага — списками в строке. Свой шаг ещё и
 * переносится за ручку, правится и убирается.
 */
export function PathEntryRow({
  row,
  number,
  words,
  type,
  fallback,
  knobsNote,
  isKnobSaving,
  isDragging,
  dragHandle,
  onOpen,
  onKnob,
  onEdit,
  onRemove,
}: PathEntryRowProps) {
  const { t, i18n } = useTranslation();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hint = useHint(anchorRef);
  // useId, а не ключ строки: «whole:a.b» и «whole:a_b» после замены знаков
  // совпадали, и подсказка одной строки читалась у другой.
  const hintId = useId();
  const step = row.kind === 'entry' && row.entry.kind === 'custom' ? row.entry.step : undefined;
  const gate = step?.gate ? pickLang(step.gate, i18n.language) : '';
  const line = words.isDescribing ? t('groupBuilder.describing') : words.line;

  return (
    <li
      className={`${styles.row} ${styles[`type-${type}`] ?? ''} ${isDragging ? styles.dragging : ''}`}
    >
      {dragHandle ? (
        <button
          type="button"
          className={styles.handle}
          aria-label={t('groupBuilder.drag.handle', { title: words.title })}
          aria-describedby={`${hintId}-drag`}
          title={t('groupBuilder.drag.handleHint')}
          {...dragHandle}
        >
          <Icon name="grip" size={16} />
          <span id={`${hintId}-drag`} hidden>
            {t('groupBuilder.drag.handleHint')}
          </span>
        </button>
      ) : (
        <span className={styles.handleSpace} aria-hidden="true" />
      )}
      <span className={styles.number} aria-hidden="true">
        {number}
      </span>
      <div className={styles.body}>
        <span
          ref={anchorRef}
          className={styles.anchor}
          onMouseEnter={hint.show}
          onMouseLeave={hint.hide}
        >
          <button
            type="button"
            className={styles.open}
            aria-describedby={hintId}
            onClick={onOpen}
            onFocus={hint.show}
            onBlur={hint.hide}
          >
            <span className={styles.title}>{words.title}</span>
            <TypeChip type={type} />
            {step?.needsTranslation && (
              <Badge tone="warning">{t('groupPath.needsTranslation')}</Badge>
            )}
          </button>
          <RowHint id={hintId} isShown={hint.isShown} words={words} fallback={fallback} />
        </span>
        {line && (
          <span className={`${styles.line} ${words.isDescribing ? styles.lineMuted : ''}`}>
            {line}
          </span>
        )}
        {(step?.anchor === 'triage' || gate) && (
          <span className={styles.meta}>
            {step?.anchor === 'triage' && t('groupPath.triageChat')}
            {gate && t('groupPath.gate', { gate })}
          </span>
        )}
        {knobsNote && <span className={styles.meta}>{knobsNote}</span>}
        {row.knobs.length > 0 && (
          <div className={styles.knobs}>
            {row.knobs.map((knob) => (
              <KnobSelect
                key={knobId(knob)}
                knob={knob}
                stepTitle={words.title}
                isSaving={isKnobSaving}
                onChange={(value) => onKnob(knob, value)}
              />
            ))}
          </div>
        )}
      </div>
      {step && (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="edit" size={16} />}
            onClick={() => onEdit(step)}
            aria-label={t('groupPath.edit', { title: words.title })}
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="trash" size={16} />}
            onClick={() => onRemove(step)}
            aria-label={t('groupPath.remove', { title: words.title })}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Подсказка строки на языке интерфейса. Слов нет, а строка — ресурс: спросим
 * его сводку, но только у показанной подсказки — промах кэша стоит модели.
 */
function RowHint({ id, isShown, words, fallback }: RowHintProps) {
  const { t } = useTranslation();
  let body = words.hint;
  if (!body && words.isDescribing) body = t('groupBuilder.describing');
  return (
    <StepHint id={id} isShown={isShown}>
      {body && <span>{body}</span>}
      {!body && fallback && isShown && <RowTextView text={fallback} variant="hint" />}
      {!body && !fallback && <span>{t('groupBuilder.noLine')}</span>}
    </StepHint>
  );
}

/**
 * Показ подсказки: наведение или фокус. Escape прячет её, не трогая фокус и
 * не закрывая окно вокруг: слушатель на window в фазе захвата срабатывает
 * раньше, чем окно на document. Но Escape, у которого есть свой хозяин —
 * поле ввода или другое окно поверх, — идёт дальше: подсказка, показанная
 * одним наведением, глотала Escape поля поиска и окна, открытого над путём.
 */
function useHint(anchorRef: React.RefObject<HTMLElement | null>) {
  const [isShown, setIsShown] = useState(false);
  useEffect(() => {
    if (!isShown) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!ownsEscape(event.target, anchorRef.current)) event.stopPropagation();
      setIsShown(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isShown, anchorRef]);
  return { isShown, show: () => setIsShown(true), hide: () => setIsShown(false) };
}

/** Escape у элемента свой: поле ввода или другое окно, открытое поверх строки. */
function ownsEscape(target: EventTarget | null, anchor: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  const windowOf = (node: Element | null): Element | null =>
    node?.closest('[role="dialog"]') ?? null;
  return windowOf(target) !== windowOf(anchor);
}

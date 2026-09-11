import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { findCompromise } from '@agentdeck/contracts';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { HELP_ROUTE } from '@shared/config/routes';
import { formatDate } from '@shared/lib/format';
import { cn } from '@shared/lib/cn';
import styles from './compromise-mark.module.scss';
import type { CompromiseMarkProps } from './compromise-mark.types';

/** Отступ от края окна, при котором подсказку разворачиваем в другую сторону. */
const EDGE_GAP = 12;

/**
 * Знак компромисса: флажок вплотную к тому, что он объясняет.
 *
 * Почему не `title=`: атрибут не открывается с клавиатуры, не читается частью
 * скринридеров, не форматируется и исчезает на телефоне. Подпись обязана быть
 * доступна ровно так же, как сам элемент, поэтому здесь настоящая кнопка,
 * связанная с текстом через `aria-describedby`.
 *
 * Открывается и по наведению, и по фокусу; закрывается Escape, и фокус
 * возвращается на кнопку. Ссылка «подробнее» стоит в разметке сразу за
 * кнопкой — Tab из кнопки ведёт в неё, а не мимо подсказки.
 */
export function CompromiseMark({ id, className }: CompromiseMarkProps) {
  const { t, i18n } = useTranslation();
  const entry = findCompromise(id);
  const panelId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Подсказка широкая, а флажок стоит и у правого края таблицы: перед показом
  // меряем, влезает ли она вправо, и при нехватке места разворачиваем влево.
  const [alignEnd, setAlignEnd] = useState(false);

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    setAlignEnd(rect.right > window.innerWidth - EDGE_GAP);
  }, [open]);

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    setAlignEnd(false);
    if (focusTrigger) buttonRef.current?.focus();
  }, []);

  // Подпись, которой нет в реестре, — опечатка в вызове. Пустой значок молча
  // соврал бы, что объяснение есть, поэтому не рисуем ничего.
  if (!entry) return null;

  const name = t(`compromise.items.${id}.name`);
  const severity = t(`compromise.severity.${entry.severity}`);

  return (
    <span
      ref={wrapperRef}
      // Зацепка для обходов доступности и клавиатуры: подсказку надо открыть,
      // иначе оба прогона проверяют закрытый значок и молчат про содержимое.
      data-compromise-mark={id}
      className={cn(styles.root, className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => close(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !wrapperRef.current?.contains(next)) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={cn(styles.trigger, styles[entry.severity])}
        aria-label={t('compromise.markLabel', { name, severity })}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <Icon name="flag" size={16} />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="note"
          className={cn(styles.panel, alignEnd && styles.alignEnd)}
        >
          <Typography variant="body-sm" weight="medium" as="p" className={styles.head}>
            {name}
          </Typography>
          <Typography variant="caption" color="muted" as="p">
            {t('compromise.headline', {
              severity,
              date: formatDate(entry.since, i18n.language),
            })}
          </Typography>

          <Typography variant="caption" weight="medium" as="p" className={styles.subhead}>
            {t('compromise.how')}
          </Typography>
          <Typography variant="body-sm" as="p">
            {t(`compromise.items.${id}.how`)}
          </Typography>

          <Typography variant="caption" weight="medium" as="p" className={styles.subhead}>
            {t('compromise.why')}
          </Typography>
          <Typography variant="body-sm" as="p">
            {t(`compromise.items.${id}.why`)}
          </Typography>

          <Typography variant="caption" weight="medium" as="p" className={styles.subhead}>
            {t('compromise.revisit')}
          </Typography>
          <Typography variant="body-sm" as="p">
            {t(`compromise.items.${id}.revisitWhen`)}
          </Typography>

          <Link to={HELP_ROUTE} search={{ topic: 'platform' }} className={styles.more}>
            {t('compromise.more')}
            <Icon name="chevronRight" size={16} />
          </Link>
        </div>
      )}
    </span>
  );
}

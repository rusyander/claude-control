import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Root, Trigger, Portal, Content } from '@radix-ui/react-popover';
import { DayPicker } from 'react-day-picker';
import type { DateRange, Matcher } from 'react-day-picker';
import { enUS, ru } from 'react-day-picker/locale';
import { Icon } from '@shared/ui/icon';
import { formatLocalDay, formatValueLabel, parseLocalDay } from './date-picker.lib';
import type { DatePickerProps } from './date-picker.types';
import 'react-day-picker/style.css';
import styles from './date-picker.module.scss';

/**
 * Выбор даты или диапазона календарём во всплывающем окне.
 *
 * Диапазон и одиночная дата — не два разных элемента управления, а одно
 * поведение: первый клик по календарю уже даёт законченный выбор из одних
 * суток и применяется сразу, второй растягивает его в диапазон. Поэтому после
 * первого клика окно остаётся открытым — иначе диапазон было бы не выбрать, —
 * а закрывается, когда границы разошлись.
 *
 * Нативный `input[type=date]` не подошёл: его календарь рисует браузер, он
 * игнорирует тему приложения, не умеет диапазон и на каждой ОС выглядит иначе.
 */
export function DatePicker({
  mode = 'range',
  value,
  onChange,
  min,
  max,
  placeholder,
  ariaLabel,
  align = 'start',
  isActive = false,
}: DatePickerProps) {
  const { i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const from = parseLocalDay(value.from);
  const to = parseLocalDay(value.to);
  const minDate = parseLocalDay(min);
  const maxDate = parseLocalDay(max);

  // Даты вне разрешённых границ гасим списком матчеров: объект `{before, after}`
  // в этой библиотеке означает промежуток МЕЖДУ краями, то есть ровно наоборот.
  const disabled: Matcher[] = [];
  if (maxDate) disabled.push({ after: maxDate });
  if (minDate) disabled.push({ before: minDate });

  const applyRange = (next: DateRange | undefined): void => {
    if (!next?.from) {
      onChange({});
      return;
    }
    const nextFrom = formatLocalDay(next.from);
    const nextTo = next.to ? formatLocalDay(next.to) : nextFrom;
    onChange({ from: nextFrom, to: nextTo });
    if (nextFrom !== nextTo) setIsOpen(false);
  };

  const applySingle = (next: Date | undefined): void => {
    if (!next) {
      onChange({});
      return;
    }
    const day = formatLocalDay(next);
    onChange({ from: day, to: day });
    setIsOpen(false);
  };

  const shared = {
    locale: i18n.language.startsWith('ru') ? ru : enUS,
    disabled,
    // Открываемся на месяце выбранной даты, а не всегда на текущем: иначе после
    // выбора прошлогоднего периода календарь каждый раз возвращает в сегодня.
    defaultMonth: from ?? maxDate,
    endMonth: maxDate,
    startMonth: minDate,
    autoFocus: true,
    className: styles.calendar,
  };

  return (
    <Root open={isOpen} onOpenChange={setIsOpen}>
      <Trigger className={styles.trigger} aria-label={ariaLabel} data-active={isActive}>
        <Icon name="calendar" size={16} />
        <span className={styles.label}>{formatValueLabel(value, i18n.language, placeholder)}</span>
      </Trigger>

      <Portal>
        {/*
          Всплывающее окно Radix — это role="dialog", и без имени скринридер
          объявляет его безымянным диалогом (axe: aria-dialog-name). Берём то же
          название, что и у кнопки: открывшееся окно — её продолжение.
        */}
        <Content
          className={styles.popover}
          aria-label={ariaLabel}
          align={align}
          sideOffset={6}
          collisionPadding={12}
        >
          {mode === 'range' ? (
            <DayPicker
              {...shared}
              mode="range"
              numberOfMonths={2}
              selected={from ? { from, to } : undefined}
              onSelect={applyRange}
            />
          ) : (
            <DayPicker {...shared} mode="single" selected={from} onSelect={applySingle} />
          )}
        </Content>
      </Portal>
    </Root>
  );
}

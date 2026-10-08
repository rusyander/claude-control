import {
  stripScrollDelta,
  revealScrollLeft,
  nextPageTab,
  pageTabDomId,
  pageTabPanelDomId,
} from '@shared/lib/page-tab';
import type { PageTabsProps } from '../page-tabs.types';
import { useRef, useEffect } from 'react';
import styles from '../page-tabs.module.scss';
import { Icon } from '@shared/ui/icon';

/** Ближайший предок с прокруткой — область, к верху которой липнет полоса. */
export function scrollerOf(node: HTMLElement | null): HTMLElement | null {
  let scroller = node?.parentElement ?? null;
  while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  return scroller;
}

/**
 * Липкая полоса закрывает щель над собой (отступ колонки лежит внутри области
 * прокрутки) заливкой цвета фона — но только когда она ПРИЛИПЛА. На нулевой
 * прокрутке та же заливка легла бы поверх карточки над полосой и срезала бы её
 * низ. Флаг ставится атрибутом прямо на узел: перерисовка React ради тени лишняя.
 */
export function markWhenStuck(node: HTMLElement | null): (() => void) | undefined {
  const scroller = scrollerOf(node);
  if (!node || !scroller) return undefined;
  const root = scroller;
  const update = (): void => {
    const offset = node.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const inset = parseFloat(getComputedStyle(root).paddingTop) || 0;
    node.dataset.stuck = String(root.scrollTop > 0 && offset <= inset + 1);
  };
  update();
  root.addEventListener('scroll', update, { passive: true });
  return () => root.removeEventListener('scroll', update);
}

/**
 * Прокрутить область к месту полосы в потоке. Это место у прилипшей полосы
 * не видно по её рамке — на миг снимаем прилипание и меряем: без отрисовки,
 * одно синхронное чтение раскладки.
 */
export function bringStripBack(node: HTMLElement | null): void {
  const root = scrollerOf(node);
  if (!node || !root || node.dataset.stuck !== 'true') return;
  node.style.position = 'static';
  const naturalTop = node.getBoundingClientRect().top;
  node.style.position = '';
  const inset = parseFloat(getComputedStyle(root).paddingTop) || 0;
  const delta = stripScrollDelta(naturalTop, root.getBoundingClientRect().top, inset);
  if (delta < 0) root.scrollTop += delta;
}

/**
 * Полоса вкладок страницы раздела: одна вкладка — одна забота страницы.
 *
 * Это настоящий `tablist`, а не ряд кнопок: Tab заводит в полосу одной
 * остановкой (фокусируема только активная вкладка), стрелки/Home/End ходят по
 * вкладкам и сразу их открывают. Полоса липнет к верху прокрутки — длинная
 * вкладка не уводит переключатель за экран.
 */
export function PageTabs<T extends string>({
  page,
  label,
  tabs,
  active,
  onSelect,
}: PageTabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const stripRef = useRef<HTMLDivElement>(null);
  const ids = tabs.map((tab) => tab.id);

  useEffect(() => markWhenStuck(stripRef.current), []);

  // Узкий экран: полоса — одна строка с прокруткой вбок, и открытая вкладка
  // (в том числе пришедшая по ссылке) не должна прятаться за краем. Счётчики
  // приходят позже подписей и расширяют вкладки — поэтому пересчёт и по ним,
  // иначе последняя вкладка оставалась обрезанной у края.
  const widthKey = tabs.map((tab) => `${tab.label}:${tab.count ?? ''}`).join('|');
  useEffect(() => {
    const strip = stripRef.current;
    const tab = refs.current.get(active);
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = revealScrollLeft(
      tab.offsetLeft,
      tab.offsetWidth,
      strip.scrollLeft,
      strip.clientWidth,
    );
  }, [active, widthKey]);

  /**
   * Выбор человеком (не первое открытие): прилипшая полоса возвращается на своё
   * место, и новая вкладка открывается с начала, а не на отметке прокрутки
   * прежней — иначе её подпись оказывалась за верхом экрана.
   */
  const choose = (tab: T): void => {
    bringStripBack(stripRef.current);
    onSelect(tab);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = nextPageTab(ids, active, event.key);
    if (!next) return;
    event.preventDefault();
    choose(next);
    refs.current.get(next)?.focus();
  };

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      className={styles.tabs}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={pageTabDomId(page, tab.id)}
            aria-selected={isActive}
            // Панель есть только у открытой вкладки: ссылка неактивной вела бы
            // в пустоту, и чтец объявлял бы несуществующий элемент.
            aria-controls={isActive ? pageTabPanelDomId(page, tab.id) : undefined}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => choose(tab.id)}
          >
            {tab.icon && <Icon name={tab.icon} size={18} />}
            {tab.label}
            {tab.note ? (
              <span className={`${styles.count} ${styles.countWarning}`}>{tab.note}</span>
            ) : (
              tab.count !== undefined && (
                <span className={styles.count} title={tab.countHint}>
                  {tab.count}
                  {tab.countHint && <span className={styles.srOnly}>{` — ${tab.countHint}`}</span>}
                </span>
              )
            )}
          </button>
        );
      })}
    </div>
  );
}

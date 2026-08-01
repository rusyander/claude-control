import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Root, Portal, Overlay, Content, Title } from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { DIALOG, FADE, DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion';
import { useDebouncedValue } from '@shared/hooks/use-debounced-value';
import { NAV_ITEMS } from '@shared/config/navigation';
import { KIND_ICON } from '@shared/config/search-kind-icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { useSearch, MIN_SEARCH_LENGTH } from '@entities/Search';
import { useProviders, activeCapabilities, visibleNavItems } from '@entities/Provider';
import { rankByFuzzy } from '../model/fuzzy';
import type { CommandPaletteProps, PaletteOption } from './CommandPalette.types';
import styles from './CommandPalette.module.scss';

/** Сколько разделов показывать в быстром переходе, чтобы список не разрастался. */
const NAV_LIMIT = 6;

/**
 * Командная палитра: одно поле, из которого можно и перепрыгнуть в раздел
 * (нечёткий поиск по названиям навигации), и найти запись в конфигурации (тот же
 * `/api/search`, что и на странице поиска). Открывается по Ctrl/Cmd+K, стрелки и
 * Enter выбирают, Escape закрывает. Доступность (фокус-ловушка, aria) — от Radix
 * Dialog; поле и список связаны как combobox+listbox.
 */
export function CommandPalette({ isOpen, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isReduced = useReducedMotion();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebouncedValue(query, 200);
  const trimmed = debounced.trim();
  const isSearchReady = trimmed.length >= MIN_SEARCH_LENGTH;
  const { data: searchData } = useSearch(isSearchReady ? debounced : '');
  const { data: providers } = useProviders();

  // Разделы, скрытые у активного провайдера (`unsupported`), не предлагаем к
  // переходу. Для Claude видимы все — набор быстрого перехода не меняется.
  const reachable = useMemo(
    () => visibleNavItems(NAV_ITEMS, activeCapabilities(providers)),
    [providers],
  );

  // Сброс при каждом открытии: палитра всегда открывается чистой, а фокус ведём
  // в поле сами — Radix мы попросили не забирать его на первый элемент.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const close = (): void => onOpenChange(false);

  const go = (to: string, search?: Record<string, string>): void => {
    // Пути собираются строкой (реестр разделов, ответ сервера), типизированного
    // дерева маршрутов здесь нет — отсюда приведение.
    void navigate({ to, search } as never);
    close();
  };

  const navOptions = useMemo<PaletteOption[]>(() => {
    const ranked = rankByFuzzy(reachable, query, (item) => t(item.label));
    return ranked.slice(0, NAV_LIMIT).map(({ item }) => ({
      id: `nav:${item.path}`,
      icon: item.icon,
      title: t(item.label),
      subtitle: item.path,
      run: () => go(item.path),
    }));
    // t и navigate стабильны между рендерами; пересобираем на смену запроса/набора.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, reachable]);

  const searchOptions = useMemo<PaletteOption[]>(() => {
    if (!isSearchReady) return [];
    return (searchData?.results ?? []).map((result) => ({
      id: `search:${result.kind}:${result.id}`,
      icon: KIND_ICON[result.kind],
      title: result.title,
      subtitle: result.snippet || t(`search.section.${result.kind}`),
      run: () => go(`/${result.pagePath}`, { id: result.id }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchData, isSearchReady]);

  const options = useMemo(() => [...navOptions, ...searchOptions], [navOptions, searchOptions]);

  // Держим подсветку в границах списка при любой смене выдачи.
  const safeIndex = options.length === 0 ? 0 : Math.min(activeIndex, options.length - 1);
  const activeOption = options[safeIndex];

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (options.length === 0 ? 0 : (current + 1) % options.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) =>
        options.length === 0 ? 0 : (current - 1 + options.length) % options.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activeOption?.run();
    }
  };

  const fade = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);
  const dialog = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);

  return (
    <Root open={isOpen} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {isOpen && (
          <Portal forceMount>
            <Overlay asChild forceMount>
              <motion.div
                className={styles.overlay}
                variants={FADE}
                initial="hidden"
                animate="visible"
                exit="hidden"
                transition={fade}
              />
            </Overlay>

            <Content
              asChild
              forceMount
              aria-label={t('palette.title')}
              // Описания у палитры нет — само поле объясняет назначение; явный
              // undefined снимает предупреждение Radix об отсутствии Description.
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                // Фокус ведём на поле сами: по умолчанию Radix отдаёт его первому
                // элементу, а нам нужно печатать сразу.
                event.preventDefault();
              }}
            >
              <motion.div
                className={styles.panel}
                variants={DIALOG}
                initial="hidden"
                animate="visible"
                exit="hidden"
                transition={dialog}
              >
                <Title className={styles.srOnly}>{t('palette.title')}</Title>

                <div className={styles.inputRow}>
                  <Icon name="search" size={24} className={styles.inputIcon} />
                  <input
                    ref={inputRef}
                    className={styles.input}
                    type="text"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActiveIndex(0);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t('palette.placeholder')}
                    aria-label={t('palette.title')}
                    role="combobox"
                    aria-expanded={options.length > 0}
                    aria-controls={listId}
                    aria-activedescendant={activeOption?.id}
                    autoComplete="off"
                  />
                </div>

                {options.length > 0 ? (
                  <ul className={styles.list} id={listId} role="listbox">
                    {options.map((option, index) => (
                      <li
                        key={option.id}
                        id={option.id}
                        role="option"
                        aria-selected={index === safeIndex}
                        className={[styles.option, index === safeIndex ? styles.active : '']
                          .filter(Boolean)
                          .join(' ')}
                        onClick={option.run}
                        onMouseMove={() => setActiveIndex(index)}
                      >
                        <Icon name={option.icon} size={24} className={styles.optionIcon} />
                        <Stack gap="var(--spacing-3xs)" minWidth={0}>
                          <Typography variant="body-sm" weight="medium" as="span" truncate>
                            {option.title}
                          </Typography>
                          {option.subtitle && (
                            <Typography variant="caption" color="subtle" as="span" truncate>
                              {option.subtitle}
                            </Typography>
                          )}
                        </Stack>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className={styles.empty}>
                    <Typography variant="body-sm" color="muted">
                      {trimmed.length === 0
                        ? t('palette.hint')
                        : t('palette.empty', { query: trimmed })}
                    </Typography>
                  </div>
                )}

                <div className={styles.footer}>
                  <Typography variant="caption" color="subtle" as="span">
                    {t('palette.footer')}
                  </Typography>
                </div>
              </motion.div>
            </Content>
          </Portal>
        )}
      </AnimatePresence>
    </Root>
  );
}

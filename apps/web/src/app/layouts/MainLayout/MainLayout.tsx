import { useMemo, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { DURATION, EASE, RISE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { useMediaQuery } from '@shared/hooks/use-media-query/useMediaQuery';
import { Stack } from '@shared/ui/stack';
import { useAttentionBadge } from '@shared/lib/attention';
import { useAwaitingAlarm } from '@entities/Chat';
import { OnboardingWizard } from '@app/onboarding/OnboardingWizard';
import { ProviderTrustBadge } from '@features/ProviderTrust';
import { DevRestartBanner } from '@features/DevRestartBanner';
import { Sidebar } from './Sidebar';
import { AppShortcuts } from './AppShortcuts';
import styles from './MainLayout.module.scss';

const STORAGE_KEY = 'agentdeck:sidebar-collapsed';

/** Каркас приложения: постоянная боковая навигация и область раздела. */
export function MainLayout() {
  // Состояние панели переживает перезагрузку: свернули один раз — осталось так.
  const [isCollapsed, setIsCollapsed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === 'true',
  );

  const toggle = (): void => {
    setIsCollapsed((current) => {
      localStorage.setItem(STORAGE_KEY, String(!current));
      return !current;
    });
  };

  // Ключом служит адрес: при переходе в раздел React пересоздаёт блок, и
  // содержимое проявляется, а не возникает рывком.
  const path = useRouterState({ select: (state) => state.location.pathname });
  // Раздел, который сам держит свои прокрутки (чат, библиотека тестов), —
  // флаг маршрута `staticData.layout`. Остальные растут с содержимым.
  const isFill = useRouterState({
    select: (state) => state.matches.some((match) => match.staticData?.layout === 'fill'),
  });
  const isReduced = useReducedMotion();

  // На узких экранах панель не должна съедать ширину контента: до 900px её
  // принудительно держим свёрнутой в рейку из значков (навигация остаётся
  // доступной), сколько бы ни стояло в сохранённом состоянии.
  const isNarrow = useMediaQuery('(max-width: 900px)');
  const effectiveCollapsed = isCollapsed || isNarrow;

  // Точка на значке вкладки и в её заголовке — за неувиденный повод (`shared/lib/attention`).
  // Живёт в каркасе, а не в чате: уйти в другой раздел и не узнать, что тебя
  // спросили, — ровно тот случай, ради которого метка и заводилась. Сюда же
  // сходятся разговоры, стоящие на вопросе по данным транскрипта: их агента
  // панель не запускала, и без этого списка о них некому было сообщить.
  // Время последней записи — часть повода: новый вопрос того же чата зовёт заново.
  const awaiting = useAwaitingAlarm();
  const awaitingMarks = useMemo(
    () => awaiting.map((chat) => ({ id: chat.id, since: chat.updatedAt })),
    [awaiting],
  );
  useAttentionBadge(awaitingMarks);

  return (
    <Stack direction="row" className={styles.root}>
      <Sidebar isCollapsed={effectiveCollapsed} onToggle={toggle} isNarrow={isNarrow} />
      <Stack as="main" className={styles.content} data-page-fill={isFill || undefined}>
        {/* Бейдж доверия виден в КАЖДОМ разделе, а не только на странице выбора
            (IDEA-9): настройки чужого CLI правятся здесь, и знать, чей формат
            панель пишет и проверялся ли он на этой машине, нужно именно здесь.
            Для Claude компонент возвращает null — постоянная плашка у дефолтного
            провайдера была бы шумом. */}
        <ProviderTrustBadge />
        {/* Правки сервера ждут конца живых ходов (dev-сторож): видно в любом разделе. */}
        <DevRestartBanner />

        <motion.div
          key={path}
          // Обёртка не должна менять раскладку: страницы вроде чата занимают
          // всю высоту и рассчитывают быть полноценным блоком колонки.
          className={styles.page}
          data-layout-page
          data-page-fill={isFill || undefined}
          variants={RISE}
          initial="hidden"
          animate="visible"
          transition={withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced)}
        >
          <Outlet />
        </motion.div>
      </Stack>

      {/* Горячие клавиши и командная палитра — здесь есть контекст роутера. */}
      <AppShortcuts />

      {/* Приветственный мастер первого запуска — поверх всего, пока не пройден. */}
      <OnboardingWizard />
    </Stack>
  );
}

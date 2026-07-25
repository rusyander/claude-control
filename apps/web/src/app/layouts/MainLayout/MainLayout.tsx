import { useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { DURATION, EASE, RISE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { useMediaQuery } from '@shared/hooks/use-media-query/useMediaQuery';
import { Stack } from '@shared/ui/stack';
import { OnboardingWizard } from '@app/onboarding/OnboardingWizard';
import { ProviderTrustBadge } from '@features/ProviderTrust';
import { Sidebar } from './Sidebar';
import { AppShortcuts } from './AppShortcuts';
import styles from './MainLayout.module.scss';

const STORAGE_KEY = 'claude-control:sidebar-collapsed';

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
  const isReduced = useReducedMotion();

  // На узких экранах панель не должна съедать ширину контента: до 900px её
  // принудительно держим свёрнутой в рейку из значков (навигация остаётся
  // доступной), сколько бы ни стояло в сохранённом состоянии.
  const isNarrow = useMediaQuery('(max-width: 900px)');
  const effectiveCollapsed = isCollapsed || isNarrow;

  return (
    <Stack direction="row" className={styles.root}>
      <Sidebar isCollapsed={effectiveCollapsed} onToggle={toggle} isNarrow={isNarrow} />
      <Stack as="main" className={styles.content}>
        {/* Бейдж доверия виден в КАЖДОМ разделе, а не только на странице выбора
            (IDEA-9): настройки чужого CLI правятся здесь, и знать, чей формат
            панель пишет и проверялся ли он на этой машине, нужно именно здесь.
            Для Claude компонент возвращает null — постоянная плашка у дефолтного
            провайдера была бы шумом. */}
        <ProviderTrustBadge />

        <motion.div
          key={path}
          // Обёртка не должна менять раскладку: страницы вроде чата занимают
          // всю высоту и рассчитывают быть полноценным блоком колонки.
          className={styles.page}
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

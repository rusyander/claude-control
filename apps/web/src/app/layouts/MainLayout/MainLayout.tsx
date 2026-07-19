import { useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { DURATION, EASE, RISE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { Stack } from '@shared/ui/stack';
import { Sidebar } from './Sidebar';
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

  return (
    <Stack direction="row" className={styles.root}>
      <Sidebar isCollapsed={isCollapsed} onToggle={toggle} />
      <Stack as="main" className={styles.content}>
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
    </Stack>
  );
}

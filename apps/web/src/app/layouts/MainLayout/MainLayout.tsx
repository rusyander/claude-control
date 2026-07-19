import { useState } from 'react';
import { Outlet } from '@tanstack/react-router';
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

  return (
    <Stack direction="row" className={styles.root}>
      <Sidebar isCollapsed={isCollapsed} onToggle={toggle} />
      <Stack as="main" className={styles.content}>
        <Outlet />
      </Stack>
    </Stack>
  );
}

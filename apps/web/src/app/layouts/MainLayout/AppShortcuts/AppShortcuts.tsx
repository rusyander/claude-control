import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useHotkeys } from '@shared/hooks/use-hotkeys';
import type { HotkeyBinding } from '@shared/lib/hotkeys';
import { CommandPalette } from '@features/CommandPalette';

/**
 * Глобальные горячие клавиши и командная палитра приложения. Живёт внутри
 * каркаса, а не в корне: переходам нужен контекст роутера. Набор клавиш
 * небольшой и намеренно предсказуемый — Ctrl/Cmd+K и `/` открывают палитру,
 * `g` с последующей буквой прыгает в раздел, `?` ведёт в справку. Полный список
 * с подписями показывает сама палитра.
 */
export function AppShortcuts() {
  const navigate = useNavigate();
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  const bindings = useMemo<HotkeyBinding[]>(() => {
    // Пути собираются строкой, типизированного дерева маршрутов здесь нет.
    const go = (to: string) => () => void navigate({ to } as never);

    return [
      // Работает и когда фокус в поле ввода — палитру нужно звать откуда угодно.
      { chord: 'mod+k', handler: () => setIsPaletteOpen((open) => !open), allowInInput: true },
      { chord: '/', handler: () => setIsPaletteOpen(true) },
      { chord: '?', handler: go('/help') },
      { chord: 'g o', handler: go('/') },
      { chord: 'g c', handler: go('/chat') },
      { chord: 'g r', handler: go('/rules') },
      { chord: 'g m', handler: go('/mcp') },
      { chord: 'g s', handler: go('/settings') },
    ];
  }, [navigate]);

  useHotkeys(bindings);

  return <CommandPalette isOpen={isPaletteOpen} onOpenChange={setIsPaletteOpen} />;
}

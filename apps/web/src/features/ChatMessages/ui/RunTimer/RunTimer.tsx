import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from '@shared/lib/format-duration';
import { MascotCameo } from '@shared/ui/mascot';
import type { RunTimerProps } from './RunTimer.types';

/**
 * Сколько идёт живой прогон. Тикает сам, раз в секунду, и только здесь: таймер
 * в состоянии ленты перерисовывал бы каждую секунду всю историю ради одной
 * цифры. Старт — у прогона (`startedAt`), не у монтирования: вкладка, открытая
 * посреди работы, показывает настоящее время, а не время с момента открытия.
 */
export function RunTimer({ since, className }: RunTimerProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);

  const elapsed = Math.max(0, now - since);

  return (
    <span className={className} role="timer" aria-live="off">
      {/* Дека выходит на долгом ходу — время берёт отсюда, своего тика нет. */}
      <MascotCameo elapsed={elapsed} />
      {t('chat.usage.live', { time: formatDuration(elapsed, t) })}
    </span>
  );
}

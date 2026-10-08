import { useEffect, useState } from 'react';
import type { WatcherStatus } from '@agentdeck/contracts';
import { elapsedMs } from '../lib/elapsedMs';

export function useWatcherElapsed(status: WatcherStatus | undefined, receivedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  const running = status?.enabled === true;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return status ? elapsedMs(status, receivedAt, now) : 0;
}

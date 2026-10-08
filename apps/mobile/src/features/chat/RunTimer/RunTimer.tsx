import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { formatDurationWith } from '@agentdeck/contracts/chat-timing';
import { useT } from '../../../shared/config/i18n';
import { styles } from './RunTimer.styles';

/**
 * Сколько идёт живой прогон — как под ответом в панели. Тикает сам, раз в
 * секунду, и только здесь: таймер в состоянии прогона перерисовывал бы весь
 * экран ради одной цифры. Старт — у прогона, не у экрана: чат, открытый
 * посреди работы, показывает настоящее время.
 */
export function RunTimer({ since }: { since: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);

  return (
    <Text style={styles.timer}>
      {t.chat.usage.live(formatDurationWith(Math.max(0, now - since), t.common.duration))}
    </Text>
  );
}

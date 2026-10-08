import type { ProviderChatStatus } from '@agentdeck/contracts';
import type { BackgroundSignal } from './model.types';
import { backgroundSignal } from './backgroundSignal';

/**
 * Следить за ходом, пока приложение в фоне. Таймеры Android там спят, поэтому
 * опрос по часам молчит; здесь каждый следующий шаг запускает ответ сети —
 * длинный опрос сервера (`?wait=`), который приходит на конце хода или на новой
 * просьбе о разрешении. Кончился ход и никто не ждёт ответа человека, вернулось
 * приложение или пропала связь — слежка заканчивается.
 *
 * Кэш экрана «хода нет» мог устареть: опрос сразу после отправки спросил раньше,
 * чем сервер завёл ход, а следующий опрос по часам уже не наступит. Поэтому при
 * тишине в кэше состояние один раз перечитывается (`fetchNow`, без ожидания).
 */
export async function watchInBackground({
  initial,
  fetchStatus,
  fetchNow,
  stillAway,
  onSignal,
  now = Date.now,
  pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  initial: ProviderChatStatus | undefined;
  fetchStatus: () => Promise<ProviderChatStatus>;
  fetchNow?: () => Promise<ProviderChatStatus>;
  stillAway: () => boolean;
  onSignal: (signal: BackgroundSignal, status: ProviderChatStatus) => void;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}): Promise<void> {
  let previous = initial;
  const busy = (status: ProviderChatStatus | undefined): boolean =>
    Boolean(status?.isRunning || status?.permissions?.length);
  if (!busy(previous) && fetchNow && stillAway()) {
    try {
      // Сигнала из этого перечтения нет: «ход шёл» здесь не видел никто.
      previous = await fetchNow();
    } catch {
      return;
    }
  }
  while (stillAway() && busy(previous)) {
    const askedAt = now();
    let next: ProviderChatStatus;
    try {
      next = await fetchStatus();
    } catch {
      return;
    }
    const signal = backgroundSignal(previous, next);
    if (signal) onSignal(signal, next);
    // Сервер без длинного опроса ответил бы сразу — не молотить его вхолостую.
    // Пауза в фоне просто доспит до возврата приложения, и слежка закончится.
    if (!signal && now() - askedAt < 1000) await pause(1000);
    previous = next;
  }
}

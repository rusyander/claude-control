import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ProviderChatStatus, ProviderInfo } from '@agentdeck/contracts';

/**
 * Разговор с чужим CLI (Codex, Qwen Code…) на телефоне — чистая часть: куда
 * ведёт уведомление и что сделает кнопка отправки. Без React и без сети, чтобы
 * проверяться тестом, а не глазами на устройстве.
 */

/** Куда открыть приложение по нажатию на уведомление. */
export type NotificationTarget =
  | { kind: 'foreign'; providerId: string; chatId: string }
  | { kind: 'claude'; chatId: string; projectPath: string };

/**
 * Данные уведомления → экран. Сервер кладёт в `chatId` ключ разговора: у чужого
 * CLI он с приставкой (`codex:<id>`), у Claude — сессия как есть. Пусто или не
 * строка (проверочное уведомление, чужая программа) — никуда не ведём.
 */
export function notificationTarget(data: unknown): NotificationTarget | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const chatId = typeof record.chatId === 'string' ? record.chatId.trim() : '';
  if (!chatId) return undefined;
  const foreign = parseForeignChatKey(chatId);
  if (foreign) return { kind: 'foreign', ...foreign };
  // Ключ с двоеточием, который не разобрался в чужой (`claude:…`), — не сессия Claude.
  if (chatId.includes(':')) return undefined;
  const projectPath = typeof record.projectPath === 'string' ? record.projectPath : '';
  return { kind: 'claude', chatId, projectPath };
}

/**
 * Что сделает отправка сейчас: обычный вопрос, слово в идущий ход (CLI примет
 * его посреди ответа) или очередь до конца ответа. Сервер решает сам по
 * `queueIfBusy`; здесь — только честная подпись кнопки.
 */
export type SendMode = 'send' | 'steer' | 'queue';

export function sendMode(status: ProviderChatStatus | undefined): SendMode {
  if (!status?.isRunning) return 'send';
  return status.steerable ? 'steer' : 'queue';
}

/**
 * Писать в разговор можно только активным CLI панели: все маршруты отправки
 * ходят от него. Чат другого CLI (открыт по уведомлению после переключения)
 * читается, но молчит — иначе вопрос ушёл бы не тому CLI.
 */
export function canWrite(activeProviderId: string | undefined, providerId: string): boolean {
  return Boolean(activeProviderId) && activeProviderId === providerId;
}

/**
 * О чём сказать в шторку, пока приложение в фоне: ответ кончился или CLI
 * попросил разрешения (ход стоит, пока человек не ответит). Сравниваются два
 * соседних опроса состояния; первого опроса нет — молчим: ход, кончившийся до
 * того, как экран посмотрел, не событие.
 */
export type BackgroundSignal = 'finished' | 'permission';

export function backgroundSignal(
  previous: ProviderChatStatus | undefined,
  next: ProviderChatStatus | undefined,
): BackgroundSignal | undefined {
  if (!previous || !next) return undefined;
  if ((next.permissions?.length ?? 0) > (previous.permissions?.length ?? 0)) return 'permission';
  if (previous.isRunning && !next.isRunning) return 'finished';
  return undefined;
}

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

/** Как сейчас решаются правки в этом разговоре — строка над лентой. */
export type EditsState = 'allowed' | 'ask' | 'denied' | 'cli';

/**
 * Переключателя «Разрешить правки» на телефоне нет (он в шапке разговора в
 * панели), но человек должен видеть, что сделает CLI с просьбой о записи. Нет
 * `editsWhenOff` — до CLI переключатель не доходит, решают его настройки.
 */
export function editsState(
  provider: Pick<ProviderInfo, 'editsWhenOff'> | undefined,
  allowEdits: boolean | undefined,
): EditsState {
  const whenOff = provider?.editsWhenOff;
  if (!whenOff) return 'cli';
  if (allowEdits === true) return 'allowed';
  return whenOff === 'ask' ? 'ask' : 'denied';
}

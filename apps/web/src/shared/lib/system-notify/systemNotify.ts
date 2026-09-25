/**
 * Системные уведомления браузера — для вкладки, на которую не смотрят.
 *
 * Человек сидит в другой вкладке, панель просто открыта (живой прогон 24.09,
 * находка 77). Тост и звук на скрытой вкладке не видны, а звук ещё и выключают;
 * зовёт в этот момент только уведомление системы. На видимой вкладке оно
 * лишнее: там уже есть тост, и два сигнала на один повод — шум.
 *
 * Разрешение спрашивается один раз и только по действию человека (клик или
 * клавиша): браузеры глушат запросы без жеста, а запрос при загрузке — ровно
 * та навязчивость, за которую разрешение и отзывают.
 */

export interface SystemNotice {
  /** Заголовок уведомления — имя панели. */
  title: string;
  /** Что случилось — тот же текст, что у тоста. */
  body: string;
  /**
   * Ключ повода: новый повод того же прогона заменяет старое уведомление, а не
   * копится стопкой.
   */
  tag: string;
  /** Куда ведёт клик — в ждущий разговор; вкладка поднимается сама. */
  onClick?: () => void;
}

/** Запомненный факт вопроса: отклонённый запрос не повторяем. */
const ASKED_KEY = 'agentdeck:notify-permission-asked';

/** Жесты, на которых браузер разрешает спросить. */
const GESTURES = ['pointerdown', 'keydown'] as const;

/** Перехват до страницы: жест, который страница гасит у себя, тоже считается. */
const CAPTURE = { capture: true } as const;

function api(): typeof Notification | undefined {
  return typeof Notification === 'undefined' ? undefined : Notification;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Показать уведомление, если вкладку не видно и разрешение дано. Возвращает,
 * ушло ли оно, — вызывающему для решения ничего больше не нужно.
 */
export function showSystemNotice(notice: SystemNotice): boolean {
  const NotificationApi = api();
  if (!NotificationApi || NotificationApi.permission !== 'granted' || !isHidden()) return false;
  try {
    const shown = new NotificationApi(notice.title, { body: notice.body, tag: notice.tag });
    shown.onclick = () => {
      // Клик по уведомлению вкладку сам не поднимает — поднимаем и ведём в чат.
      window.focus();
      notice.onClick?.();
      shown.close();
    };
    return true;
  } catch {
    // Конструктор бросает там, где уведомления только через service worker
    // (мобильный Chrome): тост и метка в заголовке остаются.
    return false;
  }
}

function wasAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Хранилище недоступно — спросим ещё раз в следующей сессии, не страшно.
  }
}

/**
 * Спросить разрешение на первом жесте человека — один раз. На загрузке не
 * спрашивает ничего; возвращает снятие подписки.
 */
export function askNotifyPermissionOnGesture(): () => void {
  const NotificationApi = api();
  if (!NotificationApi || NotificationApi.permission !== 'default' || wasAsked()) {
    return () => undefined;
  }
  const detach = (): void => {
    for (const gesture of GESTURES) document.removeEventListener(gesture, ask, CAPTURE);
  };
  function ask(): void {
    detach();
    if (NotificationApi?.permission !== 'default' || wasAsked()) return;
    rememberAsked();
    void NotificationApi.requestPermission().catch(() => undefined);
  }
  for (const gesture of GESTURES) document.addEventListener(gesture, ask, CAPTURE);
  return detach;
}

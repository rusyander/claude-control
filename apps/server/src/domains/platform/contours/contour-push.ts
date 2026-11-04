import type { AppSettings } from '@agentdeck/contracts';

/**
 * Правка контура доходит до шлюза человека сразу (s10 G7). Шлюз держит ядро на хосте звеньев и
 * перечитывает state.json панели своим тактом раз в 5 с — правка карточки, режима, активного
 * контура, защиты данных или профиля адреса жила до 5 с «записана, но не действует». Теперь после
 * каждого изменяющего запроса панель сверяет отпечаток тех полей, которые читает ядро
 * (`readPanelProfiles` ядра), и, если он сменился, просит ядро применить их (`apply`) и ждёт
 * ответа — не дольше границы клиента. Такт ядра остаётся страховкой: хост мог перезапуститься с
 * пустой настройкой, а ядро — не ответить.
 */

/** Поля state.json, из которых ядро строит маршруты шлюза человека и политику контура. */
type ContourFacts = Pick<
  AppSettings,
  'platforms' | 'activePlatformId' | 'platformGateway' | 'dlp' | 'endpointProfiles'
>;

export interface ContourPushOptions {
  /** Настройки панели сейчас (читаются заново: каталог может переехать целиком). */
  settings: () => ContourFacts;
  /** Попросить ядро применить контур; не бросает, `false` — ядро не ответило. */
  apply: () => Promise<boolean>;
}

export interface ContourPush {
  /**
   * Сверить отпечаток. Сменился — просьба ядру, и обещание дожидается её ответа; тот же —
   * обещание уже выполнено (запрос, не трогавший контур, ничего не ждёт).
   */
  settle(): Promise<void>;
}

/** Отпечаток фактов контура: тот же — ядру нечего применять. */
export function contourFactsPrint(settings: ContourFacts): string {
  return JSON.stringify([
    settings.platforms,
    settings.activePlatformId,
    settings.platformGateway,
    settings.dlp,
    settings.endpointProfiles,
  ]);
}

export function createContourPush(options: ContourPushOptions): ContourPush {
  // Отпечаток на старте — не повод для просьбы: ядро прочтёт state.json своим первым тактом.
  let last = contourFactsPrint(options.settings());
  return {
    async settle() {
      const now = contourFactsPrint(options.settings());
      if (now === last) return;
      last = now;
      // Просьбы при идущей сходятся у ядра в один свежий такт, который читает файл ПОСЛЕ записи
      // (`user-gateway-wiring.ts` `apply`) — очередь здесь не нужна.
      await options.apply().catch(() => false);
    },
  };
}

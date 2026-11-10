import type {
  BrowseAction,
  BrowseChecks,
  BrowseExpect,
  BrowseTarget,
} from '@agentdeck/contracts/core/browse';
import type { Fact } from '@agentdeck/contracts/core/facts';

/**
 * Браузер ядра для шага `walk` (этап 12, D23, P177): одна страница на сессию модели, действие —
 * только по смысловой цели, после каждого действия — проверки ядра (консоль, упавшие запросы
 * своего источника, пустая страница, страница не откликнулась).
 */

/** Одно действие страницы. Значение `fill` — уже подставленное (секрет — тоже): в журнал не идёт. */
export type BrowserAct =
  | { action: 'open'; url: string }
  | { action: 'click'; target: BrowseTarget }
  | {
      action: 'fill';
      target: BrowseTarget;
      value: string;
      /**
       * Источник стенда, к которому привязан подставленный секрет: страница в миг ввода — не там
       * (действие перед вводом увело её) → не вводится ничего.
       */
      origin?: string;
    }
  | { action: 'press'; key: string; target?: BrowseTarget }
  | { action: 'select'; target: BrowseTarget; value: string }
  | { action: 'expect'; expect: BrowseExpect; target?: BrowseTarget; value?: string }
  | { action: 'snapshot'; target?: BrowseTarget };

/** Исход действия: адрес после него, счётчики проверок и тексты находок (ещё без маски). */
export interface ActOutcome {
  action: BrowseAction;
  ok: boolean;
  url: string;
  checks: BrowseChecks;
  /** Что нашли проверки и почему действие не вышло — короткими строками; маскирует вызывающий. */
  problems: string[];
  /** Дерево доступности (`snapshot`); маскирует вызывающий. */
  snapshot?: string;
  /** Клик открыл выбор файла: ядро его не делает — пробел `file-pick`, страница не тронута. */
  filePick?: true;
  /**
   * Переход верхнего документа, который ворота перехода остановили ДО отправки запроса (ссылка,
   * перенаправление сервера, скрипт страницы) — первый с прошлого действия.
   */
  blocked?: Extract<OriginVerdict, { ok: false }>;
}

/**
 * Ворота перехода страницы сессии: судят каждый запрос верхнего документа, включая каждый шаг
 * перенаправления, до того как он уйдёт в сеть. Ресурсы страницы и рамки не судятся.
 */
export type NavigationGate = (url: string) => OriginVerdict;

/** Отказ до страницы: браузера нет (команда установки названа) или драйвер закрыт. */
export interface ActRefusal {
  refused: 'no-browser' | 'closed';
  message: string;
}

export interface BrowserDriver {
  /**
   * Действие на странице сессии; страница заводится первым вызовом. Вызовы сессии — по очереди.
   * `gate` — ворота перехода; переданные однажды, судят переходы страницы и между действиями.
   */
  act(sessionId: string, act: BrowserAct, gate?: NavigationGate): Promise<ActOutcome | ActRefusal>;
  /** Адрес страницы сессии сейчас; страницы нет — `null`. */
  urlOf(sessionId: string): string | null;
  /** Закрыть страницу сессии (сессия кончилась или молчит дольше срока). */
  release(sessionId: string): Promise<void>;
  /** Закрыть всё: страницы и сам браузер (остановка ядра). */
  close(): Promise<void>;
}

export interface BrowserDriverOptions {
  /** Сколько ждать элемент и исход действия, мс (по умолчанию 5000). */
  actionTimeoutMs?: number;
  /** Окно отклика страницы после клика или клавиши, мс (по умолчанию 600). */
  settleMs?: number;
  /** Страница сессии без вызовов дольше — закрывается, мс (по умолчанию 15 мин). */
  idleMs?: number;
  /** Свой Chromium (тест «браузера нет» — путь, которого нет); по умолчанию — кеш Playwright. */
  executablePath?: string;
  /** ОС для команды установки в отказе `no-browser` (тест; по умолчанию `currentOs()` из `platform/os-kind`). */
  platform?: NodeJS.Platform;
  /**
   * Ключи запуска Chromium — только тест: `--host-resolver-rules` даёт стенду имя (`shop.test`)
   * на 127.0.0.1, чтобы ворота источника судили не одну петлю.
   */
  args?: readonly string[];
}

/** Ворота источника прохода: страница — только на стенде проекта или на петле. */
export interface StandOrigins {
  /** Можно ли модели открыть этот адрес (до перехода). */
  open(roots: readonly string[], url: string): OriginVerdict;
  /** Можно ли остаться на адресе, куда страница пришла после действия (перенаправление, ссылка). */
  stay(roots: readonly string[], url: string): OriginVerdict;
}

/** Отказ — код `origin-not-allowed` (его видит модель) и причина, начинающаяся с него же. */
export type OriginVerdict = { ok: true } | { ok: false; code: 'origin-not-allowed'; why: string };

/** Секрет стенда для подстановки: значение — только сюда и в маску сессии. */
export interface StandSecretValue {
  value: string;
  /** Окружение «Тестов», из которого взято значение. */
  environmentId: string;
}

/** Отказы чтения секрета — без значения, с именем и причиной. */
export type StandSecretRefusal =
  | 'secret-unwired'
  | 'secret-no-project'
  | 'secret-not-for-this-page'
  | 'secret-missing'
  | 'secret-unreadable';

export interface StandSecretMiss {
  refused: StandSecretRefusal;
  message: string;
}

/**
 * Читатель доступов стенда (R2, P178): по имени секрета и адресу страницы — значение из
 * окружения блока «Тесты» того проекта, чей `baseUrl` того же источника, что страница.
 */
export interface StandSecrets {
  read(roots: readonly string[], name: string, pageUrl: string): StandSecretValue | StandSecretMiss;
}

/** Книга маски сессии (`session-keys.ts`): ядро запоминает значение, чтобы прятать его везде. */
export interface SessionMaskBook {
  record(sessionId: string, name: string, value: string): void;
}

/**
 * Всё, что нужно инструментам прохода: браузер, секреты, маска сессии. Собирает загрузка ядра
 * (`createWalkPort`); нет — инструменты отвечают `not-wired`.
 */
export interface WalkPort {
  driver: BrowserDriver;
  secrets: StandSecrets;
  /** Ворота источника: проход не уходит со стендов проекта (окружения «Тестов») и петли. */
  stands: StandOrigins;
  mask: SessionMaskBook;
  /** Значения, которые маска сессии уже знает (окружение сеанса, ключи маршрута). */
  known(taskId: string, sessionId: string): readonly string[];
  close(): Promise<void>;
}

/** Окружение «Тестов», как его читает ядро: только то, что нужно подстановке. */
export interface StandEnvironment {
  id: string;
  baseUrl?: string;
  archived?: boolean;
  secrets: string[];
}

export type EnvironmentsRead = Fact<StandEnvironment[]>;

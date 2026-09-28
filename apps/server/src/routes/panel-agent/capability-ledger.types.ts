/**
 * Классы маршрутов в реестре возможностей агента панели (G4). Каждый маршрут
 * сервера (метод + шаблон адреса из сборки приложения) стоит ровно в одном классе.
 */

/**
 * Почему маршрут только человеческий (решение владельца D2, 28.09.2026): агент
 * готовит всё и просит человека нажать кнопку сам.
 */
export type HumanReason =
  | 'split-apply'
  | 'rights'
  | 'outward'
  | 'secret'
  | 'consent'
  | 'remote'
  | 'prompt-gate'
  | 'location'
  | 'settings-import'
  | 'prompts'
  | 'code-write'
  | 'upload'
  | 'download'
  | 'paid';

/** Служебные маршруты: их зовёт само окно, поток или процесс, а не человек кнопкой. */
export type InternalKind =
  'agent' | 'stream' | 'preview' | 'assistant' | 'callback' | 'media' | 'ui-state';

/** Дорожка, которая закроет пробел действием (U-plan §1); `P3` — по запросу владельца. */
export type GapLane = 'U1' | 'U4a' | 'U4b' | 'U5a' | 'U5b' | 'P3';

/**
 * - `action:a,b` — маршрут исполняют эти действия (и только они);
 * - `human:<reason>` — агенту закрыт на любом шаге;
 * - `internal:<kind>` — служебный, не возможность интерфейса;
 * - `foreign-cli` — настройки чужих CLI (D6: отложено);
 * - `gap:<lane>` — возможность интерфейса, которой у агента пока нет.
 */
export type RouteClass =
  | `action:${string}`
  | `human:${HumanReason}`
  | `internal:${InternalKind}`
  | 'foreign-cli'
  | `gap:${GapLane}`;

/** `МЕТОД /api/шаблон` — ровно как маршрут зарегистрирован в Fastify. */
export type RouteLedger = Readonly<Record<string, RouteClass>>;

/**
 * Шаг действия, на котором оно зовёт маршрут:
 * - `card` — отпечаток и предпросмотр (до и после решения человека);
 * - `prep` — чтения внутри `route()` перед исполнением;
 * - `execute` — сам запрос, который вернул `route()`;
 * - `after` — `afterRoute`, после успешного исполнения.
 */
export type CapabilityPhase = 'card' | 'prep' | 'execute' | 'after';

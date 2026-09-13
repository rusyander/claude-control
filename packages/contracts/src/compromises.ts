/**
 * Реестр подписанных компромиссов партии «контур».
 *
 * Панель ходит в чужую платформу, которую мы не меняем, и часть её свойств
 * обойти нельзя — можно только назвать вслух. Обход без подписи и есть тот
 * самый немой костыль, который через месяц никто не объяснит: почему поток
 * разбирается руками, почему бюджет вводится с клавиатуры, почему CLI через
 * контур не правит файлы. Поэтому список заведён ДО первой строки кода, и
 * каждая следующая задача партии обязана свои обходы подписать.
 *
 * Что где лежит:
 * - здесь — машинная часть: идентификатор, уровень, дата, где обход живёт в
 *   коде, есть ли у него своё место на экране;
 * - в словаре (`compromise.items.<id>` в `ru.ts`/`en.ts`) — тексты: название,
 *   «как это работает», «почему так», «когда пересмотреть». Словарь выбран не
 *   для красоты: `en.ts` типизирован против `ru.ts`, и это единственный способ
 *   гарантировать, что подпись существует на обоих языках, а не только на том,
 *   на котором её писали.
 *
 * `codeAnchors` — список файлов, где стоит комментарий `// compromise: <id>`.
 * Пустой список читается как «подписано заранее, кода ещё нет»: так реестр
 * заполнен целиком с самого начала, а `tools/qa/check-compromises.mjs` требует
 * комментарий в коде и значок на экране ровно с того момента, как задача
 * впишет сюда первый путь. Появившийся в коде якорь при пустом списке — тоже
 * поломка сборки: реестр отстал от кода.
 */

/** Уровень: цвет никогда не единственный носитель смысла, рядом всегда слово. */
export type CompromiseSeverity =
  /** Свойство платформы, которое обойти нельзя. */
  | 'limitation'
  /** Обход на нашей стороне: работает, но стоит нам кода. */
  | 'workaround'
  /** Работает, но у человека может отняться в неудачный момент. */
  | 'risk';

export const COMPROMISE_SEVERITIES: CompromiseSeverity[] = ['limitation', 'workaround', 'risk'];

/**
 * Идентификаторы — единственное, что задачи партии пишут в коде руками, поэтому
 * они короткие и читаются без словаря.
 */
export const COMPROMISE_IDS = [
  'no-client-tools',
  'dialect-bridge',
  'vendor-sse-frames',
  'status-451-bridge',
  'gateway-required',
  'cli-no-endpoint',
  'nonstream-120s',
  'budget-manual',
  'pricing-local',
  'telemetry-local',
  'kb-via-owner',
  'key-cache-lag',
  'probe-guess',
  'context-managed',
  'agents-manual-roster',
  'tool-shim',
  'shim-no-cache',
  'no-effort',
  'rules-partial',
  'media-by-capability',
  'mask-unrestorable',
] as const;

export type CompromiseId = (typeof COMPROMISE_IDS)[number];

export interface CompromiseEntry {
  id: CompromiseId;
  severity: CompromiseSeverity;
  /** Дата подписи, ISO. Показывается рядом с уровнем: «Ограничение · с 09.09.2026». */
  since: string;
  /** Файлы с комментарием `// compromise: <id>`. Пусто — код ещё не написан. */
  codeAnchors: string[];
  /**
   * У обхода нет своего элемента на экране, и это осознанно: он живёт в
   * проводах. Такой всё равно виден в блоке «Компромиссы» отдельной группой —
   * тихо исчезнуть нельзя ни одному. Причина — в словаре, `hiddenReason`.
   */
  uiHidden?: boolean;
}

/**
 * Записан отдельной картой по идентификатору, а не массивом: `Record` по
 * union'у не даёт забыть ни одного при добавлении нового идентификатора —
 * пропуск ловится компилятором, а не глазами на ревью.
 */
const REGISTRY: Record<CompromiseId, Omit<CompromiseEntry, 'id'>> = {
  'no-client-tools': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: [
      'apps/server/src/domains/platform/drivers/enterprise-platform.ts',
      'apps/server/src/domains/platform/apply/targets.ts',
    ],
  },
  'dialect-bridge': {
    severity: 'workaround',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/gateway/pipeline.ts'],
  },
  'vendor-sse-frames': {
    severity: 'workaround',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/gateway/frames.ts'],
    uiHidden: true,
  },
  'status-451-bridge': {
    severity: 'workaround',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/gateway/frames.ts'],
  },
  'gateway-required': {
    severity: 'risk',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/gateway/listener.ts'],
  },
  'cli-no-endpoint': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/apply/targets.ts'],
  },
  'nonstream-120s': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/gateway/upstream.ts'],
    uiHidden: true,
  },
  'budget-manual': {
    severity: 'workaround',
    since: '2026-09-09',
    // Счёт ведёт СЕРВЕР по постоянному учёту (Т8): счётчик живого шлюза
    // обнуляется вместе с процессом, и клиент своей правды о бюджете не имеет.
    codeAnchors: ['apps/server/src/domains/platform/spend.ts'],
  },
  'pricing-local': {
    severity: 'workaround',
    since: '2026-09-09',
    codeAnchors: [
      'apps/server/src/domains/models/platform-catalog.ts',
      'apps/web/src/pages/Settings/PricingCard.tsx',
    ],
  },
  'telemetry-local': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/lib/app-store/platform-spend.ts'],
  },
  'kb-via-owner': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/drivers/enterprise-platform.ts'],
  },
  'key-cache-lag': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/probe.ts'],
  },
  'probe-guess': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/drivers/openai-compat.ts'],
  },
  'context-managed': {
    severity: 'limitation',
    since: '2026-09-09',
    codeAnchors: ['apps/server/src/domains/platform/gateway/frames.ts'],
  },
  // Подписано 10.09.2026, при Т7: план обещал брать список агентов из пробы, а
  // такого маршрута на публичной поверхности ключа нет вовсе.
  'agents-manual-roster': {
    severity: 'limitation',
    since: '2026-09-10',
    codeAnchors: [
      'packages/contracts/src/platform.ts',
      'apps/server/src/domains/platform/agents.ts',
    ],
  },
  // Подписано 12.09.2026, при Т5. Два обхода, а не один: первый — что вызов
  // инструмента едет текстом (это можно выключить и остаться с чатом), второй —
  // что этот текст платится в каждом ходе (это выключить нельзя вовсе).
  'tool-shim': {
    severity: 'workaround',
    since: '2026-09-12',
    codeAnchors: [
      'apps/server/src/domains/platform/gateway/pipeline.ts',
      'apps/server/src/domains/platform/gateway/frames.ts',
    ],
  },
  'shim-no-cache': {
    severity: 'limitation',
    since: '2026-09-12',
    codeAnchors: ['apps/server/src/domains/platform/gateway/tool-shim/protocol.ts'],
  },
  'no-effort': {
    severity: 'limitation',
    since: '2026-09-12',
    codeAnchors: [
      'apps/server/src/domains/platform/drivers/enterprise-platform.ts',
      'apps/server/src/domains/platform/routing.ts',
    ],
  },
  'rules-partial': {
    severity: 'limitation',
    since: '2026-09-12',
    codeAnchors: [
      'apps/server/src/domains/platform/layers.ts',
      'apps/server/src/domains/platform/routing.ts',
    ],
  },
  'media-by-capability': {
    severity: 'limitation',
    since: '2026-09-12',
    codeAnchors: [
      'apps/server/src/domains/media/images.ts',
      // Презентации подписаны тем же компромиссом: мерка одна — возможность
      // объявлена или дорога агента, — и решают её два места.
      'apps/server/src/domains/media/presentations.ts',
    ],
  },
  'mask-unrestorable': {
    severity: 'risk',
    since: '2026-09-12',
    codeAnchors: ['apps/server/src/domains/platform/gateway/frames.ts'],
    // Остановка называется в самом вызове — сообщением чата и строкой следа
    // запроса; постоянного места на экране у неё нет.
    uiHidden: true,
  },
};

/** Реестр в порядке объявления идентификаторов — он же порядок показа. */
export const COMPROMISES: CompromiseEntry[] = COMPROMISE_IDS.map((id) => ({
  id,
  ...REGISTRY[id],
}));

export function findCompromise(id: string): CompromiseEntry | undefined {
  return COMPROMISES.find((entry) => entry.id === id);
}

export function isCompromiseId(value: string): value is CompromiseId {
  return COMPROMISE_IDS.includes(value as CompromiseId);
}

/**
 * Строка реестра в том виде, в каком её отдаёт сервер. Решает, что подписано,
 * именно он: иначе снятая подпись осталась бы висеть в разметке до следующей
 * правки фронта.
 */
export interface CompromiseView {
  id: CompromiseId;
  severity: CompromiseSeverity;
  since: string;
  /** Обход ещё не написан — подпись заведена заранее. */
  planned: boolean;
  /** Своего элемента на экране нет; текст причины — в словаре. */
  uiHidden: boolean;
}

export interface CompromisesResponse {
  items: CompromiseView[];
}

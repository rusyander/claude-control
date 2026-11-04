// Границы слоёв монорепы: FSD у фронта, `routes → domains → providers → lib` у сервера.
//
// Проверяются здесь, а не в ESLint: у dependency-cruiser есть рабочий резолвер путей
// (`tsconfig.depcruise.json`) и он отличает импорт в чужой слайс от соседнего файла своей папки.
//
// Поправки против эталона доктрины (там `src` — корень пакета):
//  1) правила запускаются из корня монорепы, цель — apps/web/src, поэтому якори
//     путей — `^apps/web/src/…`, а не `^src/…` (иначе не совпадали бы ни с чем);
//  2) алиасы @shared/@entities/@features/@pages/@app резолвятся из отдельного
//     tsconfig без extends (обычный apps/web/tsconfig.json depcruise не грузит);
//  3) barrel-правило разделено на «снаружи слоёв» и «между слайсами» и НЕ трогает
//     импорты внутри одного слайса (компонент тянет свои `ui/model/*` — норма).
//
// Запуск: depcruise apps/web/src (см. корневой скрипт `depcruise`).
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.(d\\.ts|d\\.mts|test\\.tsx?|stories\\.tsx)$' },
      to: {},
    },
    // Cross-feature запрещён: одна feature не тянет другую.
    // Исключение — ResourceFiles: переиспользуемый блок (дерево файлов ресурса),
    // завязанный на entity Resource, поэтому в shared его не вынести. Его
    // встраивают редакторы (SkillEditor и др.). Чистый путь на будущее —
    // перенести его UI в entities/Resource/ui; пока разрешаем точечно.
    {
      name: 'no-cross-feature',
      severity: 'error',
      from: { path: '^apps/web/src/features/([^/]+)/' },
      to: {
        path: '^apps/web/src/features/(?!$1)([^/]+)/',
        pathNot: '^apps/web/src/features/ResourceFiles/',
      },
    },
    // Слои только вниз: entities не тянет features/pages/app
    {
      name: 'entities-downward-only',
      severity: 'error',
      from: { path: '^apps/web/src/entities/' },
      to: { path: '^apps/web/src/(features|pages|app)/' },
    },
    // shared не тянет ничего выше себя
    {
      name: 'shared-is-leaf',
      severity: 'error',
      from: { path: '^apps/web/src/shared/' },
      to: { path: '^apps/web/src/(entities|features|pages|app)/' },
    },
    // Снаружи слоёв (страница, приложение) в сегмент — только через его index,
    // не в его внутренности.
    {
      name: 'through-barrel-outer',
      severity: 'error',
      from: { path: '^apps/web/src/(?:app|pages)/' },
      to: {
        path: '^apps/web/src/(?:entities|features)/[^/]+/[^/]+/.+',
        pathNot: 'index\\.(ts|tsx)$',
      },
    },
    // Между слайсами: в ЧУЖОЙ сегмент — только через index; свой сегмент
    // (тот же $1) тянуть можно как угодно — это внутренняя кухня слайса.
    {
      name: 'through-barrel-cross-slice',
      severity: 'error',
      from: { path: '^apps/web/src/(?:entities|features)/([^/]+)/' },
      to: {
        path: '^apps/web/src/(?:entities|features)/([^/]+)/[^/]+/.+',
        pathNot: ['index\\.(ts|tsx)$', '^apps/web/src/(?:entities|features)/$1/'],
      },
    },
    // --- Сервер: слои объявлены только прозой в AGENTS.md, здесь они становятся проверкой.
    // Направление: index/bootstrap/context → routes → domains → providers → lib → contracts.
    // Обратные рёбра ниже и запрещены; `no-circular` выше ловит остальное.
    // Тесты из правил исключены намеренно: тест собирает сцену из любого слоя — это его работа.
    {
      name: 'server-lib-is-leaf',
      comment:
        'lib/ — форматные и системные хелперы. Он не знает ни про домены, ни про маршруты, ни про ' +
        'реестр провайдеров, ни про сборку приложения. Всё, что зависит от реестра, живёт в providers/.',
      severity: 'error',
      from: { path: '^apps/server/src/lib/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^apps/server/src/(domains|routes|providers|bootstrap)/|^apps/server/src/(context|index)\\.ts$',
      },
    },
    {
      name: 'server-providers-below-domains',
      comment:
        'providers/ — каталог возможностей и путей CLI; он ниже доменов и не тянет их обратно.',
      severity: 'error',
      from: { path: '^apps/server/src/providers/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^apps/server/src/(domains|routes|bootstrap)/|^apps/server/src/(context|index)\\.ts$',
      },
    },
    {
      name: 'server-domains-below-routes',
      comment:
        'Домен не знает ни про HTTP-слой, ни про сборку приложения: он принимает примитивы ' +
        '(paths, store, backupDir), а не ServerContext.',
      severity: 'error',
      from: { path: '^apps/server/src/domains/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/server/src/(routes|bootstrap)/|^apps/server/src/(context|index)\\.ts$' },
    },
    {
      name: 'server-routes-below-bootstrap',
      comment:
        'bootstrap/ — сборка приложения (рантайм, таблица маршрутов, баннер), самый верхний слой ' +
        'вместе с index.ts и context.ts. Маршрут не тянет сборку обратно: иначе цикл и скрытая ' +
        'зависимость от порядка регистрации.',
      severity: 'error',
      from: { path: '^apps/server/src/routes/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/server/src/bootstrap/|^apps/server/src/index\\.ts$' },
    },
    // Общая бочка контрактов: сервер берёт из неё ТОЛЬКО типы.
    {
      name: 'server-contracts-barrel-types-only',
      comment:
        '`packages/contracts/src/index.ts` реэкспортирует соседей без расширений, а сервер идёт под ' +
        '--experimental-strip-types: первый же импорт ЗНАЧЕНИЯ из бочки грузит её в рантайме и валит ' +
        'старт процесса целиком (ERR_MODULE_NOT_FOUND, панель не поднимается вовсе). Значение берётся ' +
        'подпутём «@agentdeck/contracts/<модуль>» — ровно для этого он и заведён в exports пакета.',
      severity: 'error',
      from: { path: '^apps/server/src/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^packages/contracts/src/index\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    // Знание о конкретном контуре кончается в drivers/.
    {
      name: 'platform-gateway-knows-no-contour',
      comment:
        'Шлюз, проба и весь остальной домен платформы спрашивают МАНИФЕСТ драйвера, а не имя ' +
        'контура: имена полей, свои коды отказа и вендорные кадры живут в drivers/<контур>.ts и ' +
        'достаются через реестр drivers/index.ts. Прямой импорт конкретного драйвера возвращает ' +
        'ветвление по платформе в общий код — ровно то, из-за чего второй контур потребовал бы ' +
        'переписать половину домена (инвариант 5 партии). Тесты исключены: им драйвер нужен как ' +
        'материал.\n' +
        'Запрет стоит на ОБОИХ приложениях, а не на одном домене платформы: маршрут, соседний ' +
        'домен или экран, потянувший enterprise-platform.ts напрямую, возвращает то же ветвление ровно теми ' +
        'же руками — и его прежняя редакция правила не видела вовсе.',
      severity: 'error',
      from: {
        path: '^apps/(server|web)/src/',
        pathNot: '^apps/server/src/domains/platform/drivers/|\\.test\\.ts$',
      },
      to: { path: '^apps/server/src/domains/platform/drivers/(?!index\\.ts|driver\\.ts)' },
    },
    // Ядро (`apps/core`): слои из спецификации 00 §Parts —
    // api → conductor → {части} → {journal, adapters} → platform → lib → contracts, только вниз.
    {
      name: 'core-apart-from-panel',
      comment:
        'Ядро — отдельный процесс: панель говорит с ним по HTTP, а не импортом. Импорт через ' +
        'границу в любую сторону делает перезапуск панели перезапуском задач (F12).',
      severity: 'error',
      from: { path: '^apps/core/' },
      to: { path: '^apps/(server|web|mobile)/' },
    },
    {
      name: 'core-tools-only-copied',
      comment:
        'Прогон ядра на Linux (`tools/core-linux.mjs`) несёт в контейнер из `tools/` только ' +
        'eslint-rules и mutation-guard. Импорт остального (28.10: подставной раннер тянул ' +
        '`tools/qa/stub-llama.mjs`) зелёный на Windows и красный только в контейнере.',
      severity: 'error',
      from: { path: '^apps/core/' },
      to: { path: '^tools/(?!eslint-rules/|mutation-guard\\.mjs$)' },
    },
    {
      name: 'panel-apart-from-core',
      comment: 'Обратная сторона той же границы: сервер и фронт не тянут код ядра.',
      severity: 'error',
      from: { path: '^apps/(server|web|mobile)/' },
      to: { path: '^apps/core/' },
    },
    {
      name: 'core-lib-is-leaf',
      severity: 'error',
      from: { path: '^apps/core/src/lib/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/(?!lib/)' },
    },
    {
      name: 'core-platform-above-lib-only',
      comment: 'Слой различий систем (09) ничего не знает о журнале, сценарии и CLI.',
      severity: 'error',
      from: { path: '^apps/core/src/platform/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/(?!platform/|lib/)' },
    },
    {
      name: 'core-session-host-thin',
      comment:
        'Хост сессии переживает смерть ядра (01 §Sessions), поэтому держит только платформу: ' +
        'журнал и решения живут в ядре, не в хосте.',
      severity: 'error',
      from: { path: '^apps/core/src/session-host/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/(?!session-host/|platform/|lib/)' },
    },
    {
      name: 'core-hop-host-thin',
      comment:
        'Хост звеньев переживает ядро и панель (00:52, P123): держит только платформу и пакеты ' +
        '(dlp, ключи, цены); журнал и решения ядра в него не входят — расход и отказы он отдаёт ' +
        'клиенту `routes/hops` фактами.',
      severity: 'error',
      // Стенды `__fixtures__/` — код тестов, как и сами тесты: стенд шлюза человека собирает
      // маршрут тем же `userRouteOf` ядра, что и рабочий путь, иначе проверял бы свою копию.
      from: { path: '^apps/core/src/hop-host/', pathNot: '/__fixtures__/|\\.test\\.ts$' },
      to: { path: '^apps/core/src/(?!hop-host/|platform/|lib/)' },
    },
    {
      name: 'core-journal-below-parts',
      comment:
        'Журнал не знает ни частей, ни переходников (00 §Parts: «The journal never imports adapters»).',
      severity: 'error',
      from: { path: '^apps/core/src/journal/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/(?!journal/|platform/|lib/)' },
    },
    {
      name: 'core-reduce-only-via-resume',
      comment:
        'Состояние задачи пересобирается одним путём — `resume()` (01 §State, F05, P11): ' +
        'свёртку журнала импортирует только он, а вид для чтения берёт её у него же.',
      severity: 'error',
      from: {
        path: '^apps/core/src/',
        pathNot: '^apps/core/src/journal/(resume|reduce/reduce)\\.ts$|\\.test\\.ts$',
      },
      to: { path: '^apps/core/src/journal/reduce/reduce\\.ts$' },
    },
    {
      name: 'core-adapters-below-parts',
      severity: 'error',
      from: { path: '^apps/core/src/adapters/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^apps/core/src/(api|conductor|verifier|economy|context|publisher|policy|observer|mcp)/',
      },
    },
    {
      name: 'core-parts-apart',
      comment:
        'Части не зовут нутро друг друга: обмен — типизированными решениями через дирижёра ' +
        '(00 §Parts). Своя папка и нижние слои разрешены, соседняя часть и всё выше — нет.',
      severity: 'error',
      from: {
        path: '^apps/core/src/(verifier|economy|context|publisher|policy|observer)/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: '^apps/core/src/(?!$1/|journal/|adapters/|routes/|platform/|lib/)',
      },
    },
    {
      name: 'core-routes-below-parts',
      comment:
        'Маршрут (11 R:PR-01) — слой под частями, рядом с переходниками: знает платформу, lib и ' +
        'шов контрактов. Журнал он не импортирует — пишет через данный ему RouteRecorder.',
      severity: 'error',
      from: { path: '^apps/core/src/routes/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/(?!routes/|platform/|lib/)' },
    },
    {
      name: 'core-adapters-apart-from-routes',
      comment:
        'Переходник и маршрут встречаются только в решении compat через шов ' +
        '(`contracts/core/routes`): переходник не знает, какой маршрут ему дали, маршрут — какой CLI.',
      severity: 'error',
      from: { path: '^apps/core/src/adapters/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/routes/' },
    },
    {
      name: 'core-providers-only-in-adapters-routes',
      comment:
        'Реестр CLI (P108): имена CLI знают только переходники и маршруты; литеральный линт ' +
        'строит из реестра свои правила. Остальное ядро перебирает решения, а не реестр.',
      severity: 'error',
      from: {
        path: '^apps/core/src/',
        pathNot: '^apps/core/src/(adapters|routes|literal-lint)/|/__fixtures__/|\\.test\\.ts$',
      },
      // Импорт пакета воркспейса depcruise не разрешает (exports с `.ts`): `resolved` остаётся
      // именем пакета, поэтому правило ловит и путь пакета, и само имя.
      to: { path: '^packages/providers/|(^|/)@agentdeck/providers(/|$)' },
    },
    {
      name: 'core-conductor-below-api',
      severity: 'error',
      from: { path: '^apps/core/src/conductor/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/core/src/(api|mcp)/' },
    },
    {
      name: 'core-io-only-in-platform',
      comment:
        'Внешнее чтение идёт через readFact (01 §Facts): `node:fs` и `node:child_process` ' +
        'доступны только платформе, переходникам на ней и хосту сессии. Иначе исключение ' +
        'диска снова читается как «нет» (F25). Подставные процессы `__fixtures__/` — не код ' +
        'ядра, а внешние программы тестов, как и сами тесты.',
      severity: 'error',
      from: {
        path: '^apps/core/src/',
        pathNot:
          '^apps/core/src/(platform|adapters|session-host|hop-host)/|/__fixtures__/|\\.test\\.ts$',
      },
      to: { path: '^(node:)?(fs|fs/promises|child_process)$' },
    },
    {
      name: 'core-contracts-barrel-types-only',
      comment: 'Та же причина, что у сервера: ядро идёт под --experimental-strip-types.',
      severity: 'error',
      from: { path: '^apps/core/src/', pathNot: '\\.test\\.ts$' },
      to: { path: '^packages/contracts/src/index\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    // Факты запуска CLI (`packages/providers`, спецификация 11 C2) — один источник для
    // каталога панели и переходников ядра, поэтому ни от одного из них не зависят.
    {
      name: 'providers-package-apart-from-apps',
      comment:
        'Факты запуска читают и панель, и ядро; импорт из приложения сделал бы пакет частью ' +
        'одного из них, и второй получил бы чужой слой вместе с фактами.',
      severity: 'error',
      from: { path: '^packages/providers/' },
      to: { path: '^apps/' },
    },
    {
      name: 'providers-package-pure',
      comment:
        'Факты — данные и чистые функции: ни диска, ни процессов, ни окружения ОС. Прочитать ' +
        'конфиг человека и решить про обход — дело того, кто знает путь к файлу (каталог панели).',
      severity: 'error',
      from: { path: '^packages/providers/', pathNot: '\\.test\\.ts$' },
      to: { path: '^(node:)?(fs|fs/promises|child_process|os|process)$' },
    },
    // Сита и заглушка форжа (этап 6 ядра) — общие для панели, ядра и проверок tools/qa.
    {
      name: 'publish-packages-apart-from-apps',
      comment:
        'Сита читают и панель, и публикатор ядра, заглушку форжа — тесты ядра и голый node; ' +
        'импорт из приложения сделал бы пакет частью одного из них.',
      severity: 'error',
      from: { path: '^packages/(sieves|stub-forge)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'sieves-only-contracts-and-dlp',
      comment: 'Сито судит содержимое; из пакетов ему нужны только контракты и маска секретов.',
      severity: 'error',
      from: { path: '^packages/sieves/' },
      to: { path: '^packages/', pathNot: '^packages/(sieves|contracts|dlp)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    // Алиасы фронта берутся из отдельного tsconfig без extends монорепы.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
  },
};

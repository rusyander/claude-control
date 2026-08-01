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
      from: { orphan: true, pathNot: '\\.(d\\.ts|test\\.tsx?|stories\\.tsx)$' },
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
    // --- Сервер: слои объявлены только прозой в CLAUDE.md, здесь они становятся проверкой.
    // Направление: context → routes → domains → providers → lib → contracts.
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
        path: '^apps/server/src/(domains|routes|providers)/|^apps/server/src/(context|index)\\.ts$',
      },
    },
    {
      name: 'server-providers-below-domains',
      comment:
        'providers/ — каталог возможностей и путей CLI; он ниже доменов и не тянет их обратно.',
      severity: 'error',
      from: { path: '^apps/server/src/providers/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/server/src/(domains|routes)/|^apps/server/src/(context|index)\\.ts$' },
    },
    {
      name: 'server-domains-below-routes',
      comment:
        'Домен не знает ни про HTTP-слой, ни про сборку приложения: он принимает примитивы ' +
        '(paths, store, backupDir), а не ServerContext.',
      severity: 'error',
      from: { path: '^apps/server/src/domains/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/server/src/routes/|^apps/server/src/(context|index)\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    // Алиасы фронта берутся из отдельного tsconfig без extends монорепы.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
  },
};

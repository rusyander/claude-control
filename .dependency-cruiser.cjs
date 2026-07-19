// Эталонный dependency-cruiser фронт-доктрины — усиление границ FSD.
// npm i -D dependency-cruiser ; запуск: npx depcruise src --config .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans', severity: 'warn',
      from: { orphan: true, pathNot: '\\.(d\\.ts|test\\.tsx?|stories\\.tsx)$' }, to: {},
    },
    // Cross-feature запрещён: одна feature не тянет другую
    {
      name: 'no-cross-feature', severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/(?!$1)([^/]+)/' },
    },
    // Слои только вниз: entities не тянет features/pages/app
    {
      name: 'entities-downward-only', severity: 'error',
      from: { path: '^src/entities/' },
      to: { path: '^src/(features|pages|app)/' },
    },
    // shared не тянет ничего выше себя
    {
      name: 'shared-is-leaf', severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(entities|features|pages|app)/' },
    },
    // Deep-import мимо barrel: снаружи сегмента — только через index
    {
      name: 'through-barrel', severity: 'error',
      from: { pathNot: '^src/shared/' },
      to: { path: '^src/(entities|features)/[^/]+/[^/]+/.+', pathNot: 'index\\.ts$' },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true },
};

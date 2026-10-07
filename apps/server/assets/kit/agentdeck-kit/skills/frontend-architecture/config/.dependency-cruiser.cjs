// Reference dependency-cruiser of the frontend doctrine — reinforces FSD boundaries.
// npm i -D dependency-cruiser ; run: npx depcruise src --config .dependency-cruiser.cjs
// Prove it reads the project before trusting a green run: plant one violation (lint-enforcement.md).
/* global module -- CommonJS config read by dependency-cruiser */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.(d\\.ts|test\\.tsx?|stories\\.tsx)$' },
      to: {},
    },
    // Cross-feature forbidden: one feature never pulls another
    {
      name: 'no-cross-feature',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/(?!$1)([^/]+)/' },
    },
    // Layers downward only: entities never pull features/pages/app
    {
      name: 'entities-downward-only',
      severity: 'error',
      from: { path: '^src/entities/' },
      to: { path: '^src/(features|pages|app)/' },
    },
    // shared pulls nothing above itself
    {
      name: 'shared-is-leaf',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(entities|features|pages|app)/' },
    },
    // Deep import past the barrel: from outside a segment only via index
    {
      name: 'through-barrel',
      severity: 'error',
      from: { pathNot: '^src/shared/' },
      to: { path: '^src/(entities|features)/[^/]+/[^/]+/.+', pathNot: 'index\\.ts$' },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true },
};

import { describe, it, expect } from 'vitest';
import { filterRunsByOrigin, hasBothOrigins, runLabelKeys, visibleRuns } from './runOrigin';

/**
 * История различает прогон автотестов панелью и импорт отчёта CI: обе записи —
 * `mode:'import'`, разница только в `origin`, а старая запись без поля — CI.
 */
const HISTORY = [
  { id: 'panel', mode: 'import', origin: 'e2e' },
  { id: 'ci-new', mode: 'import', origin: 'ci' },
  { id: 'ci-old', mode: 'import' },
  { id: 'agent', mode: 'run' },
];

describe('filterRunsByOrigin', () => {
  it('«все» — вся история как есть', () => {
    expect(filterRunsByOrigin(HISTORY, 'all').map((run) => run.id)).toEqual([
      'panel',
      'ci-new',
      'ci-old',
      'agent',
    ]);
  });

  it('автотесты панели — только записи с origin e2e', () => {
    expect(filterRunsByOrigin(HISTORY, 'e2e').map((run) => run.id)).toEqual(['panel']);
  });

  it('импорт из CI — и новая запись, и старая без поля; агент не попадает', () => {
    expect(filterRunsByOrigin(HISTORY, 'ci').map((run) => run.id)).toEqual(['ci-new', 'ci-old']);
  });
});

describe('hasBothOrigins', () => {
  it('оба источника — отбор нужен', () => {
    expect(hasBothOrigins(HISTORY)).toBe(true);
  });

  it('один источник или ни одного — отбор не показывается', () => {
    expect(hasBothOrigins(HISTORY.filter((run) => run.id !== 'panel'))).toBe(false);
    expect(hasBothOrigins([{ mode: 'import', origin: 'e2e' }, { mode: 'run' }])).toBe(false);
    expect(hasBothOrigins([])).toBe(false);
  });
});

describe('runLabelKeys', () => {
  it('автотесты панели — «автотесты» · «панель», импорт CI и старая запись — «импорт» · «CI»', () => {
    expect(runLabelKeys({ mode: 'import', actor: 'ci', origin: 'e2e' })).toEqual({
      mode: 'tests.runs.origin.e2e',
      actor: 'tests.runs.origin.e2eActor',
    });
    expect(runLabelKeys({ mode: 'import', actor: 'ci' })).toEqual({
      mode: 'tests.runs.mode.import',
      actor: 'tests.runs.actor.ci',
    });
    expect(runLabelKeys({ mode: 'run', actor: 'agent', origin: 'e2e' })).toEqual({
      mode: 'tests.runs.mode.run',
      actor: 'tests.runs.actor.agent',
    });
  });
});

/**
 * Отбор «автотесты» выбран, потом e2e-прогоны из истории ушли: переключатель
 * прятался (источник остался один), а отбор продолжал резать список до пустоты —
 * и снять его было нечем (F-304).
 */
describe('visibleRuns', () => {
  const both = [
    { id: 'panel', mode: 'import', origin: 'e2e' },
    { id: 'ci', mode: 'import', origin: 'ci' },
  ];

  it('оба источника — отбор виден и режет', () => {
    const view = visibleRuns(both, 'e2e');
    expect(view.showFilter).toBe(true);
    expect(view.origin).toBe('e2e');
    expect(view.list.map((run) => run.id)).toEqual(['panel']);
  });

  it('один источник остался — отбор не действует и не прячет записи', () => {
    const left = [
      { id: 'ci', mode: 'import', origin: 'ci' },
      { id: 'agent', mode: 'agent' },
    ];
    const view = visibleRuns(left, 'e2e');
    expect(view.showFilter).toBe(false);
    expect(view.origin).toBe('all');
    expect(view.list.map((run) => run.id)).toEqual(['ci', 'agent']);
  });
});

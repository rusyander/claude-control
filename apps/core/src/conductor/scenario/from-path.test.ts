import { describe, expect, it } from 'vitest';
import { scenarioProblems, type StepDef } from '@agentdeck/contracts/core/scenario';
import { PATH_ANCHORS, type PathStep } from '@agentdeck/contracts/group-path';
import { fromPath } from './from-path.ts';

/**
 * P100: «Путь» группы панели переносится в сценарий ядра без потерь — каждый вид шага (текст,
 * ресурс каждого вида, подшаг навыка, ворота, непереведённый) становится шагом со своим текстом,
 * знанием и воротами; то, что в схему не влезает, — проблема с именем, а не обрезка.
 */

const T = (en: string, ru = en): { ru: string; en: string } => ({ ru, en });

function step(id: string, over: Partial<PathStep> = {}): PathStep {
  return {
    id,
    anchor: 'work',
    order: 0,
    kind: 'prompt',
    title: T(`title ${id}`),
    prompt: T(`do ${id}`),
    source: 'en',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

const byId = (steps: readonly StepDef[], id: string): StepDef => {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

describe('fromPath (P100)', () => {
  it('a prompt step after every anchor: conveyor stages kept, each custom step chained after its stage', () => {
    const steps = PATH_ANCHORS.map((anchor) => step(`s-${anchor}`, { anchor }));
    const got = fromPath({ id: 'grp', title: 'Группа', path: { steps } });
    expect(got.problems).toEqual([]);
    const s = got.scenario?.steps ?? [];
    expect(s.map((x) => `${x.id}<${x.after.join(',')}`)).toEqual([
      'intake<',
      'path-1<intake',
      'plan<path-1',
      'path-2<plan',
      'work<path-2',
      'path-3<work',
      'review<path-3',
      'path-4<review',
      'fix<path-4',
      'path-5<fix',
      'final-gate<path-5',
      'publish<final-gate',
      'path-6<publish',
    ]);
    expect(got.ids).toEqual(
      Object.fromEntries(PATH_ANCHORS.map((a, i) => [`s-${a}`, `path-${i + 1}`])),
    );
    expect(byId(s, 'path-3').knowledge.text).toBe('do s-work');
    expect(got.scenario?.presetOf).toEqual({ id: 'feature', version: 1 });
  });

  it('resource steps of every type land in their knowledge list; gate becomes a text gate', () => {
    const steps = (['skill', 'rule', 'hook', 'script'] as const).map((type, i) =>
      step(`r-${type}`, {
        order: i,
        kind: 'resource',
        prompt: T(''),
        resource: { type, id: `my-${type}` },
        ...(type === 'skill' ? { gate: T('the skill reported done') } : {}),
      }),
    );
    const got = fromPath({ id: 'grp', title: 'Группа', path: { steps } });
    expect(got.problems).toEqual([]);
    const s = got.scenario?.steps ?? [];
    expect(byId(s, 'path-1').knowledge).toEqual({
      skills: ['my-skill'],
      rules: [],
      hooks: [],
      scripts: [],
    });
    expect(byId(s, 'path-1').gate).toEqual([
      { kind: 'text', criterion: 'the skill reported done' },
    ]);
    expect(byId(s, 'path-2').knowledge.rules).toEqual(['my-rule']);
    expect(byId(s, 'path-3').knowledge.hooks).toEqual(['my-hook']);
    expect(byId(s, 'path-4').knowledge.scripts).toEqual(['my-script']);
    expect(byId(s, 'path-4').gate).toEqual([]);
  });

  it('a within step becomes a work step carrying its skill place; untranslated text falls back to ru', () => {
    const got = fromPath({
      id: 'grp',
      title: 'Группа',
      path: {
        steps: [
          step('w', {
            within: { skillId: 'deploy', index: 2, after: 'Build' },
            title: { ru: 'Проверить', en: '' },
            prompt: { ru: 'Проверь сборку', en: '' },
            needsTranslation: true,
          }),
        ],
      },
    });
    expect(got.problems).toEqual([]);
    const w = byId(got.scenario?.steps ?? [], 'path-1');
    expect(w.kind).toBe('work');
    expect(w.title).toBe('Проверить');
    expect(w.knowledge.text).toBe('Проверь сборку');
    expect(w.within).toEqual({ skillId: 'deploy', index: 2, after: 'Build' });
  });

  it('order inside one anchor, ties kept in stored order', () => {
    const got = fromPath({
      id: 'grp',
      title: 'Группа',
      path: { steps: [step('b', { order: 1 }), step('c', { order: 1 }), step('a', { order: 0 })] },
    });
    expect(got.ids).toEqual({ a: 'path-1', b: 'path-2', c: 'path-3' });
  });

  it('flow "scenario": the group steps are the whole work, then final-gate and publish; no presetOf', () => {
    const got = fromPath({
      id: 'grp',
      title: 'Группа',
      flow: 'scenario',
      path: { steps: [step('x', { anchor: 'plan' }), step('y', { anchor: 'work' })] },
    });
    expect(got.problems).toEqual([]);
    expect(got.scenario?.steps.map((s) => s.id)).toEqual([
      'path-1',
      'path-2',
      'final-gate',
      'publish',
    ]);
    expect(got.scenario?.presetOf).toBeUndefined();
    expect(scenarioProblems(got.scenario as never)).toEqual([]);
  });

  it('legacy "Порядок работы" goes through the same migration: body → text, gate → text gate', () => {
    const got = fromPath({
      id: 'old',
      title: 'Старая',
      legacy: {
        steps: [
          { title: 'Шаг', body: 'Сделай', gate: 'Готово' },
          { title: '', body: '', gate: '' },
        ],
      },
    });
    expect(got.problems).toEqual([]);
    expect(got.ids).toEqual({ 'legacy-0': 'path-1' });
    const p = byId(got.scenario?.steps ?? [], 'path-1');
    expect([p.title, p.knowledge.text, p.gate]).toEqual([
      'Шаг',
      'Сделай',
      [{ kind: 'text', criterion: 'Готово' }],
    ]);
  });

  it('what does not fit is a named problem and no scenario — never a silent cut', () => {
    const got = fromPath({
      id: 'grp',
      title: 'Группа',
      path: {
        steps: [
          step('long', { prompt: T('x'.repeat(16_001)) }),
          step('bad-res', {
            kind: 'resource',
            resource: { type: 'skill', id: 'Not A Registry Id!' },
          }),
          step('title', { title: T('t'.repeat(201)) }),
        ],
      },
    });
    expect(got.scenario).toBeNull();
    expect(got.problems.slice(0, 3)).toEqual([
      'path step long: prompt longer than 16000',
      'path step bad-res: resource id Not A Registry Id! is not a registry id',
      'path step title: title longer than 200',
    ]);
  });

  describe('titles come in one language — the one the panel asks for — never a mix', () => {
    const steps = [
      step('own', { anchor: 'plan', title: T('Check the build', 'Проверить сборку') }),
      step('half', { anchor: 'work', title: { ru: 'Только по-русски', en: '' } }),
      step('gated', { anchor: 'work', order: 1, gate: T('tests are green', 'тесты зелёные') }),
    ];
    const titles = (lang?: 'ru' | 'en'): string[] =>
      (
        fromPath({ id: 'grp', title: 'Группа', path: { steps }, ...(lang ? { lang } : {}) })
          .scenario?.steps ?? []
      ).map((s) => s.title);

    it('ru: stage titles and own titles are the Russian side', () => {
      expect(titles('ru')).toEqual([
        'Разбор запроса',
        'План',
        'Проверить сборку',
        'Работа',
        'Только по-русски',
        'title gated',
        'Ревью',
        'Правки по ревью',
        'Финальная проверка',
        'Публикация',
      ]);
    });

    it('en: stage titles and own titles are the English side; an empty en side falls back to ru', () => {
      expect(titles('en')).toEqual([
        'Intake',
        'Plan',
        'Check the build',
        'Work',
        'Только по-русски',
        'title gated',
        'Review',
        'Review fixes',
        'Final check',
        'Publish',
      ]);
    });

    it('no lang: Russian, the same as the built-in presets', () => {
      expect(titles()).toEqual(titles('ru'));
    });

    it('what the model reads (prompt text, gate criterion) stays the English side in both languages', () => {
      for (const lang of ['ru', 'en'] as const) {
        const got = fromPath({ id: 'grp', title: 'Группа', path: { steps }, lang });
        const gated = byId(got.scenario?.steps ?? [], got.ids.gated as string);
        expect(gated.gate).toEqual([{ kind: 'text', criterion: 'tests are green' }]);
        expect(gated.knowledge.text).toBe('do gated');
      }
    });
  });

  it('an empty path is the conveyor alone', () => {
    const got = fromPath({ id: 'grp', title: '', path: { steps: [] } });
    expect(got.problems).toEqual([]);
    expect(got.scenario?.title).toBe('grp');
    expect(got.scenario?.steps.map((s) => s.id)).toEqual([
      'intake',
      'plan',
      'work',
      'review',
      'fix',
      'final-gate',
      'publish',
    ]);
  });
});

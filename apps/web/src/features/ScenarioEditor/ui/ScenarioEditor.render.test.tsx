import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { draftProblems, newStep, scenarioOf, type EditorDraft } from '../model/scenarioDraft';
import { RefusalNote } from './RefusalNote/RefusalNote';
import { ScenarioDraftEditor } from './ScenarioDraftEditor/ScenarioDraftEditor';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const draftOf = (id: string): EditorDraft => {
  const first = newStep('plan', 'План', []);
  return { id, title: 'Мой', steps: [first, newStep('work', 'Работа', [first.id])] };
};

const render = (draft: EditorDraft, isIdLocked = false): string => {
  const scenario = scenarioOf(draft, []);
  return renderToStaticMarkup(
    <ScenarioDraftEditor
      draft={draft}
      onChange={() => undefined}
      versionRef={`${scenario.id}@${scenario.version}`}
      problems={draftProblems(scenario)}
      isNotChain={false}
      isIdLocked={isIdLocked}
      isBusy={false}
      footer={null}
    />,
  );
};

describe('scenario editor render', () => {
  it('rows, «+» slots around every row, the save-as ref and an open first step form', () => {
    const html = render(draftOf('my-flow'));
    expect(html.match(/data-step-row="/g)).toHaveLength(2);
    // Место в начало и после каждого шага: шагов + 1.
    expect(html.match(/data-drop-after="/g)).toHaveLength(3);
    expect(html).toContain('data-scenario-version="my-flow@1"');
    expect(html).toContain('data-step-form="plan"');
    expect(html).toContain('data-draft-problems="0"');
    expect(html).toContain('Ядро примет форму сценария');
  });

  it('an empty id is named before any request; a locked id is read-only', () => {
    expect(render(draftOf(''))).toMatch(/data-draft-problems="[1-9]/);
    const readOnly = /<input[^>]*readonly/i;
    expect(render(draftOf('my-flow'), true)).toMatch(readOnly);
    expect(render(draftOf('my-flow'))).not.toMatch(readOnly);
  });
});

describe('core refusal note', () => {
  it('a known code speaks in its own words with the next version; the code is on the node', () => {
    const html = renderToStaticMarkup(
      <RefusalNote
        refusal={{
          status: 409,
          code: 'version-taken',
          reason: 'my-flow@1 holds other text',
          problems: [],
          next: 2,
        }}
      />,
    );
    expect(html).toContain('data-scenario-refusal="version-taken"');
    expect(html).toContain('Следующая свободная — 2');
    expect(html).toContain('my-flow@1 holds other text');
  });

  it('an unknown code shows the core reason as is', () => {
    const html = renderToStaticMarkup(
      <RefusalNote
        refusal={{
          status: 503,
          code: 'library-unreadable',
          reason: 'EACCES',
          problems: [],
          next: undefined,
        }}
      />,
    );
    expect(html).toContain('data-scenario-refusal="library-unreadable"');
    expect(html).toContain('EACCES');
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InstructionFilesView } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { InstructionFilesCard } from './instruction-files';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const VIEW: InstructionFilesView = {
  mode: 'claude-md-or-agents-md',
  source: 'default',
  read: [],
  ignored: [],
  choices: ['CLAUDE.md', 'AGENTS.md'],
  proposed: true,
  notes: [],
};

const tabStops = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)<\/button>/g)]
    .filter((match) => match[0].includes('tabindex="0"'))
    .map((match) => match[1] ?? '');

/**
 * Выбор имени файла — радиогруппа (ревью 28.09, F-244 — сосед групп): роль
 * обещает один шаг табом на группу и стрелки, значит остановка одна — у
 * выбранного имени, остальные вне порядка Tab.
 */
describe('выбор имени файла инструкций', () => {
  it('один шаг табом — у выбранного имени', () => {
    const html = renderToStaticMarkup(
      <InstructionFilesCard view={VIEW} chosenName="AGENTS.md" onChooseName={() => undefined} />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(tabStops(html)).toEqual(['AGENTS.md']);
    expect(html.match(/tabindex="-1"/g)?.length).toBe(1);
  });

  it('ничего не выбрано — остановка у первого имени, а не ни у одного', () => {
    const html = renderToStaticMarkup(
      <InstructionFilesCard view={VIEW} chosenName="other.md" onChooseName={() => undefined} />,
    );

    expect(tabStops(html)).toEqual(['CLAUDE.md']);
  });

  it('две карточки на странице — подпись группы у каждой своя', () => {
    const html = renderToStaticMarkup(
      <>
        <InstructionFilesCard view={VIEW} chosenName="CLAUDE.md" onChooseName={() => undefined} />
        <InstructionFilesCard view={VIEW} chosenName="CLAUDE.md" onChooseName={() => undefined} />
      </>,
    );
    const labelled = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);

    expect(labelled).toHaveLength(2);
    expect(new Set(labelled).size).toBe(2);
    for (const id of labelled) expect(html).toContain(`id="${id}"`);
  });
});

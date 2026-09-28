import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { SkillBlock } from './SkillBlock';
import { PathEntryRow } from './PathEntryRow';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const idsOf = (html: string, attr: string): string[] =>
  [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((match) => match[1] as string);

describe('DOM id строк и блоков пути не совпадают (F-280)', () => {
  it('блоки скиллов, чьи id отличаются пунктуацией, управляют разными телами', () => {
    const html = renderToStaticMarkup(
      <ol>
        {['a.b', 'a_b'].map((skillId) => (
          <SkillBlock
            key={skillId}
            title={skillId}
            type="our-skill"
            count={1}
            knobsText=""
            isOpen
            onToggle={() => undefined}
          >
            <li>шаг</li>
          </SkillBlock>
        ))}
      </ol>,
    );
    const controls = idsOf(html, 'aria-controls');
    expect(controls).toHaveLength(2);
    expect(new Set(controls).size).toBe(2);
  });

  it('подсказки строк «whole:a.b» и «whole:a_b» — разные элементы', () => {
    const html = renderToStaticMarkup(
      <ol>
        {['a.b', 'a_b'].map((skillId) => (
          <PathEntryRow
            key={skillId}
            row={{ kind: 'skill', key: `whole:${skillId}`, skillId, entryIndex: 0, knobs: [] }}
            number={1}
            words={{ title: skillId, line: '', hint: '', isDescribing: false }}
            type="our-skill"
            isKnobSaving={false}
            isDragging={false}
            onOpen={() => undefined}
            onKnob={() => undefined}
            onEdit={() => undefined}
            onRemove={() => undefined}
          />
        ))}
      </ol>,
    );
    const described = idsOf(html, 'aria-describedby');
    expect(described).toHaveLength(2);
    expect(new Set(described).size).toBe(2);
  });
});

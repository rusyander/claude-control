import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HookTrace } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { buildTurnTrail } from '../../lib/turnTrail';
import { TurnTrail } from './TurnTrail';

/**
 * След хода из настоящего `buildTurnTrail`: свёрнутая строка — счёт по
 * разделам, развёрнутая — что именно, пустые разделы не рисуются.
 */

const tool = (name: string, input: object) => ({ name, input: JSON.stringify(input) });
const hook = (hookName: string, fields: Partial<HookTrace> = {}): HookTrace => ({
  event: hookName.split(':')[0] ?? hookName,
  hookName,
  ...fields,
});

const TRAIL = buildTurnTrail(
  [
    tool('Skill', { skill: 'deep-review' }),
    tool('Agent', { subagent_type: 'Explore', description: 'Telegram code map', model: 'sonnet' }),
    tool('Agent', { subagent_type: 'general-purpose' }),
    tool('Bash', { command: 'node scripts/check_docs_gate.mjs', description: 'Гейт документации' }),
    tool('Bash', { command: 'pnpm test' }),
    tool('Bash', { command: 'pnpm test' }),
    tool('Bash', { command: 'git status' }),
  ],
  [
    hook('UserPromptSubmit', { context: 'Заглушка самопроверки\nвторая строка' }),
    hook('UserPromptSubmit', { name: 'review-trigger', context: 'Заглушка ревью' }),
    ...Array.from({ length: 24 }, () =>
      hook('PostToolUse:Bash', { name: 'inject-project-rules', durationMs: 45 }),
    ),
    hook('Stop', { name: 'tests-hook', durationMs: 300, exitCode: 2 }),
  ],
);

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '');
const summaryOf = (html: string): string =>
  textOf(html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? '');

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('TurnTrail — строка следа хода', () => {
  it('свёрнута по умолчанию: счёт по разделам и время хуков', async () => {
    await i18n.changeLanguage('ru');
    const html = renderToStaticMarkup(<TurnTrail trail={TRAIL} />);
    expect(html).toMatch(/^<details[^>]*data-turn-trail/);
    expect(html).not.toMatch(/^<details[^>]*\sopen/);
    expect(summaryOf(html)).toBe(
      '1 скилл · 2 агента · 3 скрипта · хуки 27, из них 2 добавили контекст · 1,4 с',
    );
  });

  it('развёрнутая — разделы и строки', async () => {
    await i18n.changeLanguage('ru');
    const html = renderToStaticMarkup(<TurnTrail trail={TRAIL} />);
    const text = textOf(html);
    expect(text).toContain('Скиллыdeep-review');
    expect(text).toContain('Explore · «Telegram code map» · sonnet');
    expect([...html.matchAll(/data-trail-script/g)]).toHaveLength(2);
    expect(text).toContain('node scripts/check_docs_gate.mjsГейт документации');
    expect(text).toContain('pnpm test ×2');
    expect(text).not.toContain('git status');
    expect(text).toContain('PostToolUse:Bashinject-project-rules ×241,1 с');
    expect(text).toContain('добавили контекст');
    expect(text).toContain('Заглушка самопроверки\nвторая строка');
    expect(html).toMatch(/data-trail-hook="Stop".*data-trail-failure[^>]*>✗ код 2</);
  });

  it('пустых разделов нет; хода без следа — строки нет', async () => {
    await i18n.changeLanguage('ru');
    const onlySkill = renderToStaticMarkup(
      <TurnTrail trail={buildTurnTrail([tool('Skill', { skill: 'commit-name' })])} />,
    );
    expect(summaryOf(onlySkill)).toBe('1 скилл');
    expect(textOf(onlySkill)).not.toMatch(/Агенты|Скрипты|Хуки/);
    const onlyScript = renderToStaticMarkup(
      <TurnTrail trail={buildTurnTrail([tool('Bash', { command: 'make build' })])} />,
    );
    expect(summaryOf(onlyScript)).toBe('1 скрипт');
    expect(textOf(onlyScript)).not.toMatch(/Скиллы|Агенты|Хуки/);
    expect(renderToStaticMarkup(<TurnTrail trail={buildTurnTrail([])} />)).toBe('');
  });

  it('по-английски — те же части', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<TurnTrail trail={TRAIL} />);
    expect(summaryOf(html)).toBe(
      '1 skill · 2 agents · 3 scripts · hooks 27, 2 of them added context · 1.4 s',
    );
  });
});

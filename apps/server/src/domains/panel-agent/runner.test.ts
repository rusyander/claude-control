import { describe, it, expect } from 'vitest';
import { PANEL_ACTIONS } from '../../routes/panel-agent/actions.ts';
import { panelAgentSystemPrompt } from './runner.ts';

/**
 * Системная дописка называет инструменты по именам. Переименованное действие
 * иначе оставило бы в промпте имя, которого модель среди инструментов не найдёт.
 */
describe('системная дописка агента панели', () => {
  it('каждое названное в ней snake_case-имя — действие реестра', () => {
    const prompt = panelAgentSystemPrompt({ route: '/help' });
    const known = new Set(PANEL_ACTIONS.map((action) => action.name));
    const named = [...prompt.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
    expect(named.length).toBeGreaterThan(4);
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it('вопрос «как сделать» ведёт в справку, а место человека подставлено', () => {
    const prompt = panelAgentSystemPrompt({ route: '/platform', title: 'Контур' });
    expect(prompt).toContain('search_help');
    expect(prompt).toContain('read_help_topic');
    expect(prompt).toContain('route /platform, page "Контур"');
  });
});

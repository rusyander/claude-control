import { describe, it, expect } from 'vitest';
import { PANEL_ACTIONS } from '../../../routes/panel-agent/actions.ts';
import { panelAgentPrompt, panelAgentSystemPrompt } from './runner.ts';
import { DEFAULT_HELP_WEB_SRC, panelAgentKnowledge } from '../help-topics/help-topics.ts';

/**
 * Системная дописка называет инструменты по именам. Переименованное действие
 * иначе оставило бы в промпте имя, которого модель среди инструментов не найдёт.
 */
describe('системная дописка агента панели', () => {
  it('каждое названное в ней snake_case-имя — действие реестра (и в тексте из справки)', async () => {
    // Карта разделов и «как связаны разделы» приходят из справки: имя действия,
    // переименованного в коде, но оставшегося в справке, краснеет здесь.
    const knowledge = await panelAgentKnowledge(DEFAULT_HELP_WEB_SRC);
    const prompt = panelAgentSystemPrompt({ route: '/help' }, knowledge);
    expect(prompt).toContain(knowledge.appMap);
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

  it('экран человека не уводится после чтения — только после сделанной правки', () => {
    const prompt = panelAgentSystemPrompt({ route: '/rules' });
    expect(prompt).toContain('Never navigate the human for a read or a question');
    expect(prompt).not.toContain('After an action, open the relevant page');
  });

  it('вопрос о СВОЕЙ настройке ведёт к чтению её состояния, а не только к справке', () => {
    const prompt = panelAgentSystemPrompt({ route: '/hooks' });
    // «Почему не срабатывает мой хук» — это состояние настройки, справка его не знает.
    const line = prompt.split('\n').find((item) => item.includes('THIS setup'));
    expect(line).toBeDefined();
    expect(line).toContain('list_hooks');
    expect(line).toContain('get_settings');
    expect(prompt).not.toContain('"how do I / what is / why"');
  });

  it('контур по ссылке: после ключа — свежая проба адреса, и только потом включение', () => {
    const prompt = panelAgentSystemPrompt({ route: '/platform' });
    const line = prompt.split('\n').find((item) => item.includes('save_contour_draft'));
    expect(line).toBeDefined();
    const probe = line!.indexOf('probe_contour_url');
    expect(probe).toBeGreaterThan(line!.indexOf('contour_status'));
    expect(line!.indexOf('enable_contour')).toBeGreaterThan(probe);
  });

  it('любой текст модели виден человеку: без рабочих заметок по-английски перед действием', () => {
    // В ленте стояло «Need the rule id; list rules.» перед вызовом — текст до
    // вызова модель считала черновиком, а окно показывает его как ответ.
    const line = panelAgentSystemPrompt({ route: '/rules' })
      .split(String.fromCharCode(10))
      .find((item) => item.includes('Every text you write'));
    expect(line).toBeDefined();
    expect(line).toContain('working notes');
  });

  it('маска в прочитанном — не повод отказаться от правки: панель вернёт значение', () => {
    // Правку правила с токеном модель отдавала человеку «вручную», хотя сервер
    // восстанавливает маски на своих местах (`unmasked`).
    const line = panelAgentSystemPrompt({ route: '/rules' })
      .split(String.fromCharCode(10))
      .find((item) => item.includes('••••••'));
    expect(line).toBeDefined();
    expect(line).toContain('keep each');
    expect(line).toContain('Never refuse');
  });
});

describe('текст хода агента панели', () => {
  const human = { role: 'user' as const, content: 'Открой тот чат' };

  it('без прежних действий — реплика как есть', () => {
    expect(panelAgentPrompt([human])).toBe('Открой тот чат');
    expect(panelAgentPrompt([human], [])).toBe('Открой тот чат');
  });

  it('итоги прежних действий разговора едут в ход: ключи и имена не читаются заново', () => {
    const text = panelAgentPrompt(
      [
        { role: 'user', content: 'Запусти чат' },
        { role: 'assistant', content: 'Запустил.' },
        human,
      ],
      ['start_chat: Done. {"started":true,"chatKey":"new-7f3a"}'],
    );
    expect(text).toContain('start_chat: Done. {"started":true,"chatKey":"new-7f3a"}');
    // Итоги — до реплики хода: последняя строка остаётся просьбой человека.
    expect(text.indexOf('new-7f3a')).toBeLessThan(text.indexOf('Human (current request)'));
    expect(text.trimEnd().endsWith('Открой тот чат')).toBe(true);
  });
});

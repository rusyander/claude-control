import { describe, expect, it } from 'vitest';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { splitRunFrames } from '../api/runStream';
import { buildPageContext, sectionLabelKey } from './pageContext';
import {
  contourKeyAnchor,
  endpointTokenAnchor,
  envSecretAnchor,
  integrationSecretAnchor,
  isSecretAnchor,
  mcpSecretAnchor,
  pageNavigation,
} from './pageTarget';
import { initialDecision, withPending, withoutPending } from './pending';

const pending = (id: string, summary = 's'): PanelPendingAction => ({
  id,
  name: 'create_project',
  risk: 'change',
  preview: { summary, fields: [] },
  createdAt: '2026-09-17T10:00:00.000Z',
  expiresAt: '2026-09-17T10:05:00.000Z',
});

describe('pageNavigation', () => {
  it('переводит focus чата в id разговора, а не в якорь', () => {
    expect(pageNavigation({ route: '/chat', focus: 'abc' })).toEqual({
      to: '/chat',
      search: { id: 'abc' },
    });
  });

  it('переводит focus тестов и настроек во вкладку', () => {
    expect(pageNavigation({ route: '/tests', focus: 'report' }).search).toEqual({ tab: 'report' });
    expect(pageNavigation({ route: '/settings?x=1', focus: 'prompts' }).search).toEqual({
      x: '1',
      tab: 'prompts',
    });
  });

  it('ключ контура: мастер на шаге ключа и якорь поля', () => {
    const focus = contourKeyAnchor('qa-dev');
    expect(pageNavigation({ route: '/platform', focus })).toEqual({
      to: '/platform',
      search: { id: 'qa-dev', tab: 'key' },
      anchor: 'contour-key:qa-dev',
    });
  });

  it('секрет MCP: форма этого сервера на полях секретов и якорь поля', () => {
    const focus = mcpSecretAnchor('github');
    expect(pageNavigation({ route: '/mcp', focus })).toEqual({
      to: '/mcp',
      search: { id: 'github', tab: 'secret' },
      anchor: 'mcp-secret:github',
    });
    expect(isSecretAnchor(focus)).toBe(true);
    expect(isSecretAnchor(contourKeyAnchor('dev'))).toBe(true);
    expect(isSecretAnchor('github')).toBe(false);
  });

  it('секрет env: переменная по ключу на правку и якорь поля значения', () => {
    const focus = envSecretAnchor('GITHUB_TOKEN');
    expect(pageNavigation({ route: '/env', focus })).toEqual({
      to: '/env',
      search: { id: 'GITHUB_TOKEN', tab: 'secret' },
      anchor: 'env-secret:GITHUB_TOKEN',
    });
    expect(isSecretAnchor(focus)).toBe(true);
    // Обычный фокус env (ключ без префикса) — якорь, адрес не трогаем.
    expect(pageNavigation({ route: '/env', focus: 'MY_FLAG' })).toEqual({
      to: '/env',
      search: {},
      anchor: 'MY_FLAG',
    });
  });

  it('токен эндпоинта: вкладка моделей с профилем; токен интеграции: вкладка интеграций', () => {
    const endpoint = endpointTokenAnchor('ep-1');
    expect(pageNavigation({ route: '/settings', focus: endpoint })).toEqual({
      to: '/settings',
      search: { id: 'ep-1', tab: 'models' },
      anchor: 'endpoint-token:ep-1',
    });
    const integration = integrationSecretAnchor('jira');
    expect(pageNavigation({ route: '/settings', focus: integration })).toEqual({
      to: '/settings',
      search: { tab: 'integrations' },
      anchor: 'integration-secret:jira',
    });
    expect(isSecretAnchor(endpoint)).toBe(true);
    expect(isSecretAnchor(integration)).toBe(true);
    // Вкладка настроек словом — по-прежнему вкладка, не секрет.
    expect(isSecretAnchor('prompts')).toBe(false);
  });

  it('чат проекта: вкладка проекта, а не id разговора', () => {
    expect(pageNavigation({ route: '/chat', focus: 'project:p-42' })).toEqual({
      to: '/chat',
      search: {},
      project: 'p-42',
    });
  });

  it('прочие разделы: focus остаётся якорем, без focus якоря нет', () => {
    expect(pageNavigation({ route: '/rules', focus: 'r1' })).toEqual({
      to: '/rules',
      search: {},
      anchor: 'r1',
    });
    expect(pageNavigation({ route: '/platform' })).toEqual({ to: '/platform', search: {} });
  });
});

describe('pending', () => {
  it('новая карточка в конец, повтор id заменяет, решённая уходит', () => {
    const list = withPending(withPending(undefined, pending('a')), pending('b'));
    expect(list.map((item) => item.id)).toEqual(['a', 'b']);
    const replaced = withPending(list, pending('a', 'новый'));
    expect(replaced.map((item) => item.preview.summary)).toEqual(['новый', 's']);
    expect(withoutPending(replaced, 'a').map((item) => item.id)).toEqual(['b']);
  });

  it('опасное действие фокусирует «Отклонить»', () => {
    expect(initialDecision('danger')).toBe('reject');
    expect(initialDecision('change')).toBe('approve');
  });
});

describe('pageContext', () => {
  it('самый длинный префикс, корень только сам себе', () => {
    expect(sectionLabelKey('/')).toBe('nav.overview');
    expect(sectionLabelKey('/chat/123')).toBe('nav.chat');
    expect(sectionLabelKey('/nowhere')).toBeUndefined();
  });

  it('адрес с запросом, пустые поля не уходят', () => {
    expect(buildPageContext({ pathname: '/settings', searchStr: '?tab=prompts' })).toEqual({
      route: '/settings?tab=prompts',
    });
    expect(
      buildPageContext({ pathname: '/', searchStr: '?', title: 'Обзор', projectPath: 'C:/w' }),
    ).toEqual({ route: '/', title: 'Обзор', projectPath: 'C:/w' });
  });
});

describe('splitRunFrames', () => {
  it('кадры, пинг и битый JSON пропущены, хвост сохранён', () => {
    const buffer =
      ': ping\n\n' +
      'data: {"kind":"text","text":"привет"}\n\n' +
      'data: {broken\n\n' +
      'data: {"kind":"done","reply":"при';
    const { events, rest } = splitRunFrames(buffer);
    expect(events).toEqual([{ kind: 'text', text: 'привет' }]);
    expect(rest).toBe('data: {"kind":"done","reply":"при');
  });
});

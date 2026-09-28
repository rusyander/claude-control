import { describe, expect, it } from 'vitest';
import { appStateDomains } from './app-state-events.ts';

describe('appStateDomains', () => {
  it('смена настроек — раздел settings (язык соседней вкладки)', () => {
    expect(appStateDomains('PATCH', '/api/settings', 200)).toEqual(['settings']);
  });

  it('импорт снимка и смена каталога — всё состояние панели', () => {
    expect(appStateDomains('POST', '/api/settings/import', 200)).toEqual(['settings', 'groups']);
    expect(appStateDomains('POST', '/api/location', 200)).toEqual(['settings', 'groups']);
  });

  it('группы, выбор стороны пары и группа чата — раздел groups', () => {
    expect(appStateDomains('DELETE', '/api/groups/abc', 204)).toEqual(['groups']);
    expect(appStateDomains('POST', '/api/groups', 200)).toEqual(['groups']);
    expect(appStateDomains('PUT', '/api/groups/abc/path/steps', 200)).toEqual(['groups']);
    expect(appStateDomains('PUT', '/api/projects/group-choice', 200)).toEqual(['groups']);
    expect(
      appStateDomains('PUT', '/api/chat/new-1/group-settings?sessionId=s1&projectPath=C%3A', 200),
    ).toEqual(['groups']);
  });

  it('чтение, отказ и чужие маршруты — ничего', () => {
    expect(appStateDomains('GET', '/api/settings', 200)).toEqual([]);
    expect(appStateDomains('PATCH', '/api/settings', 400)).toEqual([]);
    expect(appStateDomains('PUT', '/api/chat/x/group-settings', 409)).toEqual([]);
    expect(appStateDomains('POST', '/api/chat/x/run', 200)).toEqual([]);
    expect(appStateDomains('POST', '/api/groupsX', 200)).toEqual([]);
    expect(appStateDomains('PUT', '/api/chat/x/group-settings/extra', 200)).toEqual([]);
  });
});

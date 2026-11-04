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

  it('защита бэкенда заводит и убирает проектную группу — раздел groups', () => {
    expect(appStateDomains('POST', '/api/backend-guard/install', 200)).toEqual(['groups']);
    expect(appStateDomains('POST', '/api/backend-guard/remove', 200)).toEqual(['groups']);
  });

  // Маршрутов записи групп, выбора стороны пары и группы чата нет (этап 10): их пути — чужие.
  it('ушедшие маршруты групп, чтение, отказ и чужие маршруты — ничего', () => {
    expect(appStateDomains('GET', '/api/settings', 200)).toEqual([]);
    expect(appStateDomains('PATCH', '/api/settings', 400)).toEqual([]);
    expect(appStateDomains('POST', '/api/backend-guard/install', 409)).toEqual([]);
    expect(appStateDomains('POST', '/api/chat/x/run', 200)).toEqual([]);
    expect(appStateDomains('POST', '/api/groups', 200)).toEqual([]);
    expect(appStateDomains('DELETE', '/api/groups/abc', 204)).toEqual([]);
    expect(appStateDomains('PUT', '/api/projects/group-choice', 200)).toEqual([]);
    expect(appStateDomains('PUT', '/api/chat/x/group-settings', 200)).toEqual([]);
  });
});

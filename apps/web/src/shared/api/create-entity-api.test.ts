import { describe, it, expect } from 'vitest';
import { entityPath } from './create-entity-api';

describe('entityPath', () => {
  it('кодирует id права доступа: слэш в шаблоне ломал маршрут', () => {
    // `/api/permissions/deny:Read(~/.ssh/**)` — три сегмента после ресурса,
    // маршрут `/:id` не совпадал, сервер отвечал 404, и правило нельзя было
    // ни изменить, ни удалить.
    const path = entityPath('permissions', 'deny:Read(~/.ssh/**)');

    expect(path.split('/')).toHaveLength(3); // '', 'permissions', id
    expect(path).toBe('/permissions/deny%3ARead(~%2F.ssh%2F**)');
    expect(decodeURIComponent(path.slice('/permissions/'.length))).toBe('deny:Read(~/.ssh/**)');
  });

  it('обычные id остаются читаемыми', () => {
    expect(entityPath('rules', 'yazyk-obscheniya')).toBe('/rules/yazyk-obscheniya');
  });

  it('кодирует пробелы и юникод в именах серверов', () => {
    expect(entityPath('mcp', 'my server')).toBe('/mcp/my%20server');
  });
});

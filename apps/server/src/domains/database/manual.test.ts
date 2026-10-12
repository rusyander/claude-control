import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ManualConnectionNotFoundError,
  listManualConnections,
  removeManualConnection,
  saveManualConnection,
} from './manual.ts';

let appData: string;
const project = join(tmpdir(), 'some-project');
const draft = {
  label: 'Стенд',
  host: 'db.stage.example.com',
  port: 5432,
  database: 'app',
  user: 'ro',
};

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'db-manual-'));
});
afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

describe('свои подключения', () => {
  it('пароль хранится зашифрованным, в файле реквизитов его нет', () => {
    const id = saveManualConnection(appData, project, { ...draft, password: 'top-secret-pw' });
    const [connection] = listManualConnections(appData, project);
    expect(connection?.info).toMatchObject({
      id,
      source: 'manual',
      hasPassword: true,
      remote: true,
    });
    expect(connection?.password).toBe('top-secret-pw');
    for (const name of readdirSync(appData)) {
      expect(readFileSync(join(appData, name), 'utf8')).not.toContain('top-secret-pw');
    }
  });

  it('правка без пароля оставляет прежний, удаление забывает и пароль', () => {
    const id = saveManualConnection(appData, project, { ...draft, password: 'pw1' });
    saveManualConnection(appData, project, { ...draft, id, label: 'Новое имя' });
    expect(listManualConnections(appData, project)[0]).toMatchObject({
      info: { label: 'Новое имя', hasPassword: true },
      password: 'pw1',
    });
    removeManualConnection(appData, project, id);
    expect(listManualConnections(appData, project)).toEqual([]);
    // Тот же id заново — без старого пароля.
    expect(() => removeManualConnection(appData, project, id)).toThrow(
      ManualConnectionNotFoundError,
    );
  });

  it('подключения одного проекта не видны в другом', () => {
    saveManualConnection(appData, project, draft);
    expect(listManualConnections(appData, `${project}-other`)).toEqual([]);
    expect(() =>
      saveManualConnection(appData, `${project}-other`, { ...draft, id: 'manual:nope' }),
    ).toThrow(ManualConnectionNotFoundError);
  });
});

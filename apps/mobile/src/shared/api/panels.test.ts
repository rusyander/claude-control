import { describe, expect, it } from 'vitest';
import {
  applyIdentity,
  newPanelId,
  panelTitle,
  parsePanels,
  removeEntry,
  renameEntry,
  upsertByUrl,
  type PanelEntry,
} from './panels';

const entry = (patch: Partial<PanelEntry>): PanelEntry => ({
  id: 'p1',
  url: 'http://192.168.1.5:5178',
  name: '',
  machineName: '',
  machineId: '',
  platform: '',
  ...patch,
});

const desk = { platform: 'win32', machineName: 'DESKTOP-7Q', machineId: 'm-desk' };

describe('список компьютеров', () => {
  it('подпись: своё имя важнее имени машины, адрес — без схемы', () => {
    expect(panelTitle(entry({ name: 'Дом', machineName: 'DESKTOP-7Q' }))).toBe('Дом');
    expect(panelTitle(entry({ machineName: 'DESKTOP-7Q' }))).toBe('DESKTOP-7Q');
    expect(panelTitle(entry({}))).toBe('192.168.1.5:5178');
  });

  it('id годится в ключ SecureStore', () => {
    expect(newPanelId(() => 0.5)).toMatch(/^p[a-z0-9]+$/);
    expect(newPanelId()).not.toBe(newPanelId());
  });

  it('битое и чужое в сохранённом списке отбрасывается, остальное читается', () => {
    expect(parsePanels(null)).toEqual([]);
    expect(parsePanels('{не json')).toEqual([]);
    expect(parsePanels('{"id":"p1"}')).toEqual([]);
    const raw = JSON.stringify([
      { id: 'p1', url: 'http://a', machineName: 'A' },
      { id: 'bad id/..', url: 'http://b' },
      { id: 'p3' },
      null,
    ]);
    expect(parsePanels(raw)).toEqual([entry({ id: 'p1', url: 'http://a', machineName: 'A' })]);
  });

  it('тот же адрес при повторном спаривании — та же запись, новый — новая', () => {
    const list = [entry({})];
    expect(upsertByUrl(list, 'http://192.168.1.5:5178', () => 'p2')).toEqual({ list, id: 'p1' });
    const added = upsertByUrl(list, 'https://mac.tail.ts.net', () => 'p2');
    expect(added.id).toBe('p2');
    expect(added.list.map((item) => item.id)).toEqual(['p1', 'p2']);
  });

  it('машина назвалась — запись получает имя, номер и систему', () => {
    const { list, id, dropped } = applyIdentity([entry({})], 'p1', desk);
    expect({ id, dropped }).toEqual({ id: 'p1', dropped: undefined });
    expect(list[0]).toMatchObject({ machineName: 'DESKTOP-7Q', machineId: 'm-desk' });
  });

  it('тот же номер по новому адресу — одна запись: старая с именем человека и новым адресом', () => {
    const before = [
      entry({ id: 'p1', name: 'Дом', machineId: 'm-desk' }),
      entry({ id: 'p2', url: 'https://desk.tail.ts.net' }),
    ];
    const { list, id, dropped } = applyIdentity(before, 'p2', desk);
    expect({ id, dropped }).toEqual({ id: 'p1', dropped: 'p2' });
    expect(list).toEqual([
      entry({
        id: 'p1',
        name: 'Дом',
        url: 'https://desk.tail.ts.net',
        machineName: 'DESKTOP-7Q',
        machineId: 'm-desk',
        platform: 'win32',
      }),
    ]);
  });

  it('пустой номер ни с кем не склеивает', () => {
    const before = [entry({ id: 'p1' }), entry({ id: 'p2', url: 'http://b' })];
    const result = applyIdentity(before, 'p2', { ...desk, machineId: '' });
    expect(result.list).toHaveLength(2);
    expect(result.dropped).toBeUndefined();
  });

  it('переименование и удаление; удалили выбранный — выбран первый оставшийся', () => {
    const list = [entry({ id: 'p1' }), entry({ id: 'p2', url: 'http://b' })];
    expect(renameEntry(list, 'p2', '  Ноутбук ')[1]?.name).toBe('Ноутбук');
    expect(removeEntry(list, 'p1', 'p1')).toEqual({ list: [list[1]], activeId: 'p2' });
    expect(removeEntry(list, 'p1', 'p2').activeId).toBe('p2');
    expect(removeEntry([list[0] as PanelEntry], 'p1', 'p1').activeId).toBe('');
  });
});

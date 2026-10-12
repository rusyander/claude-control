import { describe, it, expect } from 'vitest';
import type { ComposeService } from '@entities/Compose';
import { serviceStateView } from './serviceState';
import { portUrl } from './portUrl';
import { parseMarkers, settingsKey, shortMarkers } from './guardError';

const service = (patch: Partial<ComposeService>): ComposeService => ({
  name: 'db',
  build: false,
  state: 'running',
  ports: [],
  dependsOn: [],
  ...patch,
});

describe('состояние сервиса для человека', () => {
  it('здоровье решает тон работающего', () => {
    expect(serviceStateView(service({ health: 'healthy' }))).toMatchObject({
      key: 'healthy',
      tone: 'success',
    });
    expect(serviceStateView(service({ health: 'starting' }))).toMatchObject({
      key: 'starting',
      pulse: true,
    });
    expect(serviceStateView(service({ health: 'unhealthy' })).tone).toBe('danger');
    expect(serviceStateView(service({})).key).toBe('running');
  });

  it('остановка сигналом — «Остановлен», не «Упал»', () => {
    for (const exitCode of [0, 137, 143]) {
      expect(serviceStateView(service({ state: 'exited', exitCode })).key).toBe('stopped');
    }
    expect(serviceStateView(service({ state: 'exited', exitCode: 1 }))).toMatchObject({
      key: 'crashed',
      tone: 'danger',
      code: 1,
    });
  });

  it('не созданный — нейтрально', () => {
    expect(serviceStateView(service({ state: 'absent' }))).toMatchObject({
      key: 'absent',
      tone: 'neutral',
    });
  });
});

describe('адрес порта', () => {
  it('все интерфейсы — localhost; свой адрес — как есть; IPv6 — в скобках; UDP — без ссылки', () => {
    const port = { published: 5433, target: 5432, protocol: 'tcp' };
    expect(portUrl({ ...port, host: '0.0.0.0' })).toBe('http://localhost:5433');
    expect(portUrl({ ...port, host: '' })).toBe('http://localhost:5433');
    expect(portUrl({ ...port, host: '127.0.0.1' })).toBe('http://127.0.0.1:5433');
    expect(portUrl({ ...port, host: '::1' })).toBe('http://[::1]:5433');
    expect(portUrl({ ...port, host: '', protocol: 'udp' })).toBeUndefined();
  });
});

describe('защита бэкенда: поле меток и отпечаток настроек', () => {
  it('строки → метки без пустых, пробелов по краям и повторов', () => {
    expect(parseMarkers('  db.prod.internal \n\n10.0.5.12\ndb.prod.internal\n')).toEqual([
      'db.prod.internal',
      '10.0.5.12',
    ]);
  });

  it('короче трёх знаков — названы до отправки', () => {
    expect(shortMarkers(['pr', 'prod-cluster', 'db'])).toEqual(['pr', 'db']);
  });

  it('порядок выключенных правил не делает черновик «изменённым», порядок меток — делает', () => {
    const base = {
      prodMarkers: ['a.prod', 'b.prod'],
      disabled: ['sql-drop', 'infra-change'],
    } as const;
    expect(
      settingsKey({ prodMarkers: [...base.prodMarkers], disabled: ['infra-change', 'sql-drop'] }),
    ).toBe(settingsKey({ prodMarkers: [...base.prodMarkers], disabled: [...base.disabled] }));
    expect(settingsKey({ prodMarkers: ['b.prod', 'a.prod'], disabled: [] })).not.toBe(
      settingsKey({ prodMarkers: ['a.prod', 'b.prod'], disabled: [] }),
    );
  });
});

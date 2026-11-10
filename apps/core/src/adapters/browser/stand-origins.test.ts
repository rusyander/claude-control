import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStandOrigins, isLoopbackHost, standOriginsOf } from './stand-origins.ts';

/**
 * Ворота источника прохода (этап 12, W3-D): набор — источники `baseUrl` неархивных окружений
 * «Тестов» корней задачи и петля буквой адреса; прочее — `origin-not-allowed`.
 */

let root: string;
let broken: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'origins-'));
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'environments.json'),
    JSON.stringify({
      version: 1,
      environments: [
        { id: 'shop', baseUrl: 'https://shop.example.com/app/', secrets: [] },
        { id: 'admin', baseUrl: 'http://admin.example.com:8080', secrets: [] },
        { id: 'old', baseUrl: 'https://old.example.com', archived: true, secrets: [] },
        { id: 'nourl', secrets: [] },
        { id: 'ftp', baseUrl: 'ftp://files.example.com', secrets: [] },
      ],
    }),
  );
  broken = mkdtempSync(join(tmpdir(), 'origins-broken-'));
  mkdirSync(join(broken, '.agent', 'tests'), { recursive: true });
  writeFileSync(join(broken, '.agent', 'tests', 'environments.json'), '{not json');
});

afterAll(() => {
  for (const dir of [root, broken]) rmSync(dir, { recursive: true, force: true });
});

describe('walk origin gate (stage 12, W3-D)', () => {
  it('the allowed set is the origins of non-archived http(s) environments; an unreadable file adds nothing', () => {
    expect([...standOriginsOf([root, broken])].sort()).toEqual([
      'http://admin.example.com:8080',
      'https://shop.example.com',
    ]);
  });

  it('loopback is the address literal only: localhost, 127.0.0.0/8, [::1]; a name that merely resolves there is not', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.0.9', '[::1]'])
      expect(isLoopbackHost(host), host).toBe(true);
    for (const host of [
      'localhost.evil.com',
      '127.0.0.1.nip.io',
      '128.0.0.1',
      '127.0.0',
      '0.0.0.0',
    ])
      expect(isLoopbackHost(host), host).toBe(false);
  });

  it('open: a stand page and loopback pass; another host, another port, an archived stand, file:, data:, javascript: are refused', () => {
    const gate = createStandOrigins();
    const ok = (url: string) => gate.open([root], url).ok;
    expect(ok('https://shop.example.com/cart?id=1')).toBe(true);
    expect(ok('http://admin.example.com:8080/')).toBe(true);
    expect(ok('http://127.0.0.1:5169/x')).toBe(true);
    expect(ok('http://localhost:3000')).toBe(true);
    expect(ok('http://[::1]:8080/')).toBe(true);
    expect(ok('about:blank')).toBe(true);
    for (const url of [
      'https://evil.example.net/?q=secret',
      'http://shop.example.com/',
      'http://admin.example.com:8081/',
      'https://old.example.com/',
      'file:///etc/passwd',
      'data:text/html,<p>x</p>',
      'javascript:alert(1)',
      'chrome-error://chromewebdata/',
      'not a url',
    ]) {
      const got = gate.open([root], url);
      expect(got.ok, url).toBe(false);
      if (!got.ok) {
        expect(got.code).toBe('origin-not-allowed');
        expect(got.why).toMatch(/^origin-not-allowed: /);
      }
    }
    expect(gate.open([], 'https://shop.example.com/').ok).toBe(false);
  });

  it("the panel's own addresses are never a walk page: API/gateway ports 5170–5180 and the panel web port on any loopback name, even registered as a stand", () => {
    // Страница панели в браузере прохода получает число страницы у ядра и ходит в API панели с её
    // источника — модель кликала бы «ответить»/«одобрить» и открывала бы секреты как человек.
    const panelRoot = mkdtempSync(join(tmpdir(), 'origins-panel-'));
    try {
      mkdirSync(join(panelRoot, '.agent', 'tests'), { recursive: true });
      writeFileSync(
        join(panelRoot, '.agent', 'tests', 'environments.json'),
        JSON.stringify({
          version: 1,
          environments: [{ id: 'self', baseUrl: 'http://localhost:8888', secrets: [] }],
        }),
      );
      const gate = createStandOrigins({ panelWebPort: 8888 });
      for (const url of [
        'http://127.0.0.1:8888/',
        'http://localhost:8888/settings',
        'http://[::1]:8888/',
        'http://127.0.0.1:5178/api/location',
        'http://localhost:5170/',
        'http://127.0.0.2:5180/',
      ]) {
        for (const judge of [gate.open, gate.stay]) {
          const got = judge([panelRoot], url);
          expect(got.ok, url).toBe(false);
          if (!got.ok) expect(got.why).toMatch(/^origin-not-allowed: .*agentdeck panel/);
        }
      }
      for (const url of ['http://127.0.0.1:5169/', 'http://127.0.0.1:5181/', 'http://[::1]:8889/'])
        expect(gate.open([panelRoot], url).ok, url).toBe(true);
      // Порт веба панели — из её настройки (`WEB_PORT`): 8888 тогда — обычный порт.
      const moved = createStandOrigins({ panelWebPort: 9999 });
      expect(moved.open([], 'http://127.0.0.1:9999/').ok).toBe(false);
      expect(moved.open([], 'http://127.0.0.1:8888/').ok).toBe(true);
      // Без настройки — порт панели по умолчанию (8888), как у сервера панели.
      const saved = process.env.WEB_PORT;
      delete process.env.WEB_PORT;
      try {
        expect(createStandOrigins().open([], 'http://localhost:8888/').ok).toBe(false);
      } finally {
        if (saved !== undefined) process.env.WEB_PORT = saved;
      }
    } finally {
      rmSync(panelRoot, { recursive: true, force: true });
    }
  });

  it('stay: the error page and a blob of a stand stay; a blob of a foreign page and a foreign host do not', () => {
    const gate = createStandOrigins();
    expect(gate.stay([root], 'chrome-error://chromewebdata/').ok).toBe(true);
    expect(gate.stay([root], 'blob:https://shop.example.com/3c1f').ok).toBe(true);
    expect(gate.stay([root], 'blob:https://evil.example.net/3c1f').ok).toBe(false);
    expect(gate.stay([root], 'https://evil.example.net/landing').ok).toBe(false);
    expect(gate.stay([root], 'data:text/html,x').ok).toBe(false);
  });
});

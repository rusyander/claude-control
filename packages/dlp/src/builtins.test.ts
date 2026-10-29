import { describe, expect, it } from 'vitest';
import { dlpBuiltinPatterns, type DlpRule } from '@agentdeck/contracts';
import { DLP_BUILTIN_IDS } from './builtins.mjs';
import { builtinRuleSet, maskRulesFor } from './default-rules.ts';
import { AliasVault, maskText } from './mask.ts';
import { scanText } from './rules.ts';

/**
 * Встроенные образцы Р11 через тот же `scanText`, которым маскирует шлюз
 * контура, прокси и хук. Каждая строка таблицы — пара «найдено» и «не тронуто»:
 * ложное срабатывание здесь стоит дороже пропуска, поэтому соседи, похожие на
 * данные (метка времени, версия, хеш коммита, loopback), проверяются так же
 * строго, как сами данные.
 *
 * Строки, похожие на ключи, собираются из частей: цельный литерал сработал бы
 * на сторожа секретов в репозитории, а ключом не является.
 */

const j = (...parts: string[]): string => parts.join('');
const TAIL = 'abcdefghijklmnopqrstuvwxyz0123456789';

const ALL: DlpRule[] = DLP_BUILTIN_IDS.map((id) => ({
  id,
  name: id,
  enabled: true,
  kind: 'builtin',
  builtin: id,
  terms: [],
  pattern: '',
  action: 'mask',
  label: id,
}));

function found(text: string): string[] {
  return scanText(text, ALL).map((match) => `${match.ruleId}:${match.value}`);
}

const HITS: [string, string][] = [
  ['+998 90 123 45 67', 'phone_intl:+998 90 123 45 67'],
  ['звоните +1 (555) 123-4567', 'phone_intl:+1 (555) 123-4567'],
  ['ОГРН 1027700132195', 'ogrn:1027700132195'],
  ['ОГРНИП 304500116000157', 'ogrn:304500116000157'],
  ['паспорт 45 06 123456', 'passport_ru:45 06 123456'],
  ['4506 №123456', 'passport_ru:4506 №123456'],
  ['паспорт серии 4506 123456', 'passport_ru:4506 123456'],
  ['загран 72 1234567', 'passport_ru_foreign:72 1234567'],
  ['72 №1234567', 'passport_ru_foreign:72 №1234567'],
  ['паспорт AA1234567', 'passport_uz:AA1234567'],
  ['IBAN GB82 WEST 1234 5698 7654 32', 'iban:GB82 WEST 1234 5698 7654 32'],
  ['счёт DE89370400440532013000', 'iban:DE89370400440532013000'],
  [
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    'crypto_wallet:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  ],
  [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    'crypto_wallet:0x52908400098527886E0F7030069857D2E4169EE7',
  ],
  ['хост 192.168.1.10:8080', 'ipv4:192.168.1.10'],
  ['::ffff:192.168.1.1', 'ipv4:192.168.1.1'],
  ['fe80::1ff:fe23:4567:890a', 'ipv6:fe80::1ff:fe23:4567:890a'],
  ['адрес 2001:db8::1.', 'ipv6:2001:db8::1'],
  ['mac 00:1A:2B:3C:4D:5E', 'mac:00:1A:2B:3C:4D:5E'],
  ['00-1a-2b-3c-4d-5e', 'mac:00-1a-2b-3c-4d-5e'],
  ['id 550e8400-e29b-41d4-a716-446655440000', 'uuid:550e8400-e29b-41d4-a716-446655440000'],
  ['см. https://docs.example.com/a/b?x=1.', 'url:https://docs.example.com/a/b?x=1'],
  [
    j('postgres://postgres', ':hunter2', '@db:5432/app'),
    j('credentials_url:postgres://postgres', ':hunter2@'),
  ],
  [j('gl', 'pat-', TAIL), j('secret_key:gl', 'pat-', TAIL)],
  [
    j('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'),
    j('secret_key:AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'),
  ],
  [j('Bea', 'rer ', TAIL), j('secret_key:Bea', 'rer ', TAIL)],
  [j('123456789', ':AA', TAIL.slice(0, 33)), j('secret_key:123456789', ':AA', TAIL.slice(0, 33))],
  [j('sk', '_live_', TAIL), j('secret_key:sk', '_live_', TAIL)],
  [
    j('-----BEGIN PGP PRIV', 'ATE KEY BLOCK-----'),
    j('secret_key:-----BEGIN PGP PRIV', 'ATE KEY BLOCK-----'),
  ],
];

const JWT = j('ey', 'JhbGciOiJIUzI1NiJ9.ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N');
HITS.push([JWT, `jwt:${JWT}`]);

const MISSES = [
  'в 2026 году +100500',
  'метка времени 1726300000000',
  'в 2026 123456 ₽',
  'в 10 1234567 шт',
  'GB82 WEST 1234 5698 7654 33',
  'коммит 3a5f1c2e9b7d4a6c8e0f1a2b3c4d5e6f7a8b9c0d',
  'локально 127.0.0.1:5178',
  'слушает 0.0.0.0',
  'версия 1.2.3',
  'время 12:30:45',
  'std::map<int, int>',
  'нулевой 00000000-0000-0000-0000-000000000000',
  'Bearer $(cat ~/.token)',
];

describe('встроенные образцы Р11', () => {
  for (const [text, hit] of HITS) {
    it(`находит: ${hit.split(':')[0]} в «${text.slice(0, 24)}»`, () => {
      expect(found(text)).toEqual([hit]);
    });
  }

  for (const text of MISSES) {
    it(`не трогает: «${text}»`, () => {
      expect(found(text)).toEqual([]);
    });
  }

  it('список образцов в контракте совпадает с серверным, порядок тоже', () => {
    // Экран строит список из контракта, сервер ищет по своему: разойдись они,
    // раздел показывал бы образец, которого нет, или молчал бы о настоящем.
    expect([...dlpBuiltinPatterns]).toEqual([...DLP_BUILTIN_IDS]);
  });
});

describe('встроенный набор маски контура', () => {
  it('ключи и JWT отклоняют запрос, остальное маскируется обратимо', () => {
    const actions = Object.fromEntries(builtinRuleSet().map((rule) => [rule.builtin, rule.action]));
    expect(actions.secret_key).toBe('block');
    expect(actions.jwt).toBe('block');
    expect(actions.email).toBe('mask');
    expect(actions.ipv4).toBe('mask');
  });

  it('метка вместо значения, значение возвращается тем же хранилищем', () => {
    const vault = new AliasVault();
    const result = maskText('пишите a.b@example.com с 192.168.1.10', builtinRuleSet(), vault);
    expect(result.text).not.toContain('example.com');
    expect(result.text).not.toContain('192.168.1.10');
    let restored = result.text;
    for (const [placeholder, value] of vault.reverse())
      restored = restored.split(placeholder).join(value);
    expect(restored).toBe('пишите a.b@example.com с 192.168.1.10');
  });

  it('пустой раздел — встроенный набор, свои правила — они, битый файл — ошибка', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'dlp-mask-'));

    expect(maskRulesFor(dir)).toMatchObject({ source: 'builtin' });

    const own = {
      ...builtinRuleSet()[0],
      id: 'own',
      name: 'Своё',
      kind: 'terms',
      terms: ['Иванов'],
    };
    writeFileSync(join(dir, 'dlp-rules.json'), JSON.stringify({ version: 1, rules: [own] }));
    const mine = maskRulesFor(dir);
    expect(mine.source).toBe('own');
    expect('rules' in mine && mine.rules.map((rule) => rule.id)).toEqual(['own']);

    writeFileSync(
      join(dir, 'dlp-rules.json'),
      JSON.stringify({ version: 1, rules: [{ ...own, enabled: false }] }),
    );
    expect(maskRulesFor(dir).source).toBe('builtin');

    writeFileSync(join(dir, 'dlp-rules.json'), '{ не json');
    expect(maskRulesFor(dir).source).toBe('broken');
  });
});

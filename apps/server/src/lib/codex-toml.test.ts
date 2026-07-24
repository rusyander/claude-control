import { describe, it, expect } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { upsertCodexRootScalar } from './codex-toml.ts';

/**
 * `upsertCodexRootScalar` — правка СКАЛЯРА КОРНЯ config.toml. Инвариант: трогается
 * только корневой ключ (до первой строки-заголовка таблицы `^\s*\[`), одноимённые
 * ключи ВНУТРИ таблиц не тронуты, всё прочее байт-в-байт.
 */
describe('upsertCodexRootScalar', () => {
  it('заменяет существующий корневой скаляр, остальное байт-в-байт', () => {
    const src = `# c
model = "gpt-5"
approval_policy = "on-request"

[mcp_servers.x]
command = "node"
`;
    const out = upsertCodexRootScalar(src, 'approval_policy', 'never');
    expect(out).toBe(`# c
model = "gpt-5"
approval_policy = "never"

[mcp_servers.x]
command = "node"
`);
  });

  it('НЕ трогает одноимённый ключ внутри таблицы [profiles.x]', () => {
    const src = `approval_policy = "on-request"

[profiles.safe]
approval_policy = "untrusted"
`;
    const out = upsertCodexRootScalar(src, 'approval_policy', 'never');
    const parsed = parseToml(out) as {
      approval_policy: string;
      profiles: Record<string, { approval_policy: string }>;
    };
    expect(parsed.approval_policy).toBe('never');
    expect(parsed.profiles.safe!.approval_policy).toBe('untrusted');
    // Строка внутри профиля буквально не изменилась.
    expect(out).toContain('[profiles.safe]\napproval_policy = "untrusted"');
  });

  it('вставляет отсутствующий ключ в конец корня, перед первой таблицей', () => {
    const src = `model = "gpt-5"

[profiles.safe]
approval_policy = "untrusted"
`;
    const out = upsertCodexRootScalar(src, 'sandbox_mode', 'read-only');
    expect(out).toBe(`model = "gpt-5"
sandbox_mode = "read-only"

[profiles.safe]
approval_policy = "untrusted"
`);
  });

  it('сохраняет хвостовой inline-комментарий при замене значения', () => {
    const src = 'approval_policy = "on-request" # почему\n';
    expect(upsertCodexRootScalar(src, 'approval_policy', 'never')).toBe(
      'approval_policy = "never" # почему\n',
    );
  });

  it('вставка в пустой текст', () => {
    expect(upsertCodexRootScalar('', 'approval_policy', 'never')).toBe(
      'approval_policy = "never"\n',
    );
  });

  it('файл только из таблиц: ключ добавляется перед первой таблицей', () => {
    const src = `[profiles.safe]
approval_policy = "untrusted"
`;
    const out = upsertCodexRootScalar(src, 'sandbox_mode', 'read-only');
    expect(out).toBe(`sandbox_mode = "read-only"
[profiles.safe]
approval_policy = "untrusted"
`);
  });

  it('значение экранируется как TOML-строка', () => {
    const out = upsertCodexRootScalar('', 'sandbox_mode', 'workspace-write');
    expect(parseToml(out)).toEqual({ sandbox_mode: 'workspace-write' });
  });
});

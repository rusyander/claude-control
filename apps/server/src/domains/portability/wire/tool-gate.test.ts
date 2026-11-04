import { describe, it, expect } from 'vitest';
import { CATALOG_PROVIDERS } from '../../../providers/catalog/catalog.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { allToolGates, toolGateOf, type GatewayToolCall, type ToolGate } from './tool-gate.ts';

/**
 * Ворота — шов между двумя доменами, и на шве живёт молчаливый класс дефектов:
 * поля, названные по-своему. У шлюза аргументы вызова зовутся `arguments`, у
 * нагрузки Claude — `tool_input`; ворота, объявленные в словах нагрузки, получали
 * от шлюза `undefined`, скрипт видел вызов без аргументов и разрешал ВСЁ.
 *
 * Поэтому здесь запускается настоящий скрипт и судит он по аргументам: подменить
 * запуск значило бы проверить вызов функции, а вопрос — что до скрипта доехало.
 */

function wireTarget(): ConfigProvider {
  const found = CATALOG_PROVIDERS.find((candidate) => candidate.id === 'continue');
  if (!found) throw new Error('в каталоге нет цели continue');
  return found;
}

const RUN = {
  provider: wireTarget(),
  run: {
    providerId: 'continue',
    sessionId: 'chat-1',
    cwd: process.cwd(),
    transcriptPath: 'C:/appdata/provider-chats/continue/chat-1.jsonl',
  },
  hooks: [
    {
      event: 'PreToolUse' as const,
      // Скрипт отказывает только тем вызовам, чьи АРГУМЕНТЫ он разобрал. Пустая
      // нагрузка здесь неотличима от разрешения — ровно так дефект и прятался.
      command:
        "node -e \"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);" +
        "if(String(p.tool_input&&p.tool_input.file_path).startsWith('secrets/'))" +
        "{process.stderr.write('в secrets/ писать нельзя');process.exit(2)}process.exit(0)})\"",
    },
  ],
};

const call = (path: string): GatewayToolCall => ({
  id: 'call-1',
  name: 'Write',
  arguments: { file_path: path },
});

describe('ворота вызова', () => {
  it('аргументы шлюза доезжают до скрипта под именем нагрузки', async () => {
    const gate = toolGateOf(RUN);

    expect(await gate.decide(call('secrets/key.txt'))).toEqual({
      allow: false,
      reason: 'в secrets/ писать нельзя',
    });
  });

  it('разрешённый путь тот же скрипт пропускает', async () => {
    // Без этой половины отказ выше доказывал бы только то, что скрипт отказывает
    // всегда — в том числе на пустой нагрузке.
    const gate = toolGateOf(RUN);

    expect(await gate.decide(call('src/a.ts'))).toEqual({ allow: true });
  });

  it('полный исход события уезжает наблюдателю — следу прогона', async () => {
    const seen: string[] = [];
    const gate = toolGateOf(RUN, (decision) => {
      seen.push(`${decision.owner}:${decision.allow ? 'allow' : 'block'}`);
    });

    await gate.decide(call('secrets/key.txt'));
    await gate.decide(call('src/a.ts'));

    expect(seen).toEqual(['wire:block', 'wire:allow']);
  });
});

describe('несколько ворот на одном прогоне (П4.2)', () => {
  const gate = (allow: boolean, reason: string, seen: string[]): ToolGate => ({
    async decide() {
      seen.push(reason);
      return allow ? { allow: true } : { allow: false, reason };
    },
  });
  const call: GatewayToolCall = { id: 'c', name: 'Write', arguments: { file_path: '/tmp/a' } };

  it('пустой список ворот не заводится вовсе', () => {
    expect(allToolGates([])).toBeUndefined();
  });

  it('пропускают только тогда, когда пропустили ВСЕ', async () => {
    const seen: string[] = [];
    const both = allToolGates([gate(true, 'хуки', seen), gate(true, 'права', seen)]);
    await expect(both?.decide(call)).resolves.toEqual({ allow: true });
    expect(seen).toEqual(['хуки', 'права']);
  });

  it('после отказа вторые ворота не спрашиваются: их побочные действия настоящие', async () => {
    const seen: string[] = [];
    const both = allToolGates([gate(false, 'хуки', seen), gate(true, 'права', seen)]);
    await expect(both?.decide(call)).resolves.toEqual({ allow: false, reason: 'хуки' });
    expect(seen).toEqual(['хуки']);
  });

  it('причина уезжает от тех ворот, которые отказали', async () => {
    const seen: string[] = [];
    const both = allToolGates([gate(true, 'хуки', seen), gate(false, 'права', seen)]);
    await expect(both?.decide(call)).resolves.toMatchObject({ reason: 'права' });
  });
});

import { describe, it, expect } from 'vitest';
import { CATALOG_PROVIDERS } from '../../../providers/catalog.ts';
import type { ConfigProvider } from '../../../providers/types.ts';
import { ToolGateRegistry, toolGateOf, type GatewayToolCall } from './tool-gate.ts';

/**
 * Ворота — шов между двумя доменами, и на шве живёт молчаливый класс дефектов:
 * поля, названные по-своему. У шлюза аргументы вызова зовутся `arguments`, у
 * нагрузки Claude — `tool_input`; ворота, объявленные в словах нагрузки, получали
 * от шлюза `undefined`, скрипт видел вызов без аргументов и разрешал ВСЁ.
 *
 * Поэтому здесь запускается настоящий скрипт и судит он по аргументам: подменить
 * запуск значило бы проверить вызов функции, а вопрос — что до скрипта доехало.
 */

function codex(): ConfigProvider {
  const found = CATALOG_PROVIDERS.find((candidate) => candidate.id === 'codex');
  if (!found) throw new Error('в каталоге нет цели codex');
  return found;
}

const RUN = {
  provider: codex(),
  run: {
    providerId: 'codex',
    sessionId: 'chat-1',
    cwd: process.cwd(),
    transcriptPath: 'C:/appdata/provider-chats/codex/chat-1.jsonl',
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

describe('реестр открытых прогонов', () => {
  const stub = { decide: async () => ({ allow: true }) };

  it('метки без прогона ворот НЕ имеют', () => {
    const registry = new ToolGateRegistry();

    // `undefined`, а не «пустые ворота»: прослойка спрашивает включённость провода
    // до первого кадра, и пустые ворота заставили бы её ждать решения, которого
    // никто не примет.
    expect(registry.gateOf('run-1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('прогон получает свои ворота и отдаёт их обратно по метке', () => {
    const registry = new ToolGateRegistry();
    registry.open('run-1', stub);

    expect(registry.gateOf('run-1')).toBe(stub);
    expect(registry.gateOf('run-2')).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it('конец прогона ворота закрывает', () => {
    // Оставленная запись — это ворота, исполняющие скрипты для прогона, которого
    // уже нет.
    const registry = new ToolGateRegistry();
    registry.open('run-1', stub);
    registry.close('run-1');

    expect(registry.gateOf('run-1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('пустая метка ворот не открывает', () => {
    // Иначе один запрос без метки открыл бы ворота всем таким же.
    const registry = new ToolGateRegistry();
    registry.open('', stub);

    expect(registry.size).toBe(0);
    expect(registry.gateOf('')).toBeUndefined();
  });
});

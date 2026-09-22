import { describe, expect, it, vi } from 'vitest';
import type { PermissionDecision, PermissionItem } from '@agentdeck/contracts/portable-env';
import {
  DEFAULT_ASK_TIMEOUT_MS,
  matchPermission,
  permissionBrokerOf,
  type PermissionOutcome,
} from './permission-broker.ts';
import type { GatewayToolCall } from './tool-gate.ts';

/**
 * БРОКЕР ПРАВ (П4.2) — то, чего таблица сверки с настоящим `claude` не видит.
 *
 * Сверка (`tools/qa/check-permission-broker.mjs`) отвечает на вопрос «то же ли
 * решение», гоняя оба движка на одном наборе правил. Она не видит и увидеть не
 * может трёх вещей, потому что у Claude их попросту нет: отказа, когда сравнить
 * аргумент не с чем; запроса прав, оставшегося без ответа; и брокера, которому
 * некого спросить. Они здесь.
 */

const source = {
  provider: 'claude',
  scope: 'global' as const,
  origin: 'file' as const,
  file: '/home/u/.claude/settings.json',
  plugin: null,
};

function permission(rule: string, decision: PermissionDecision, order = 0): PermissionItem {
  return {
    id: `permission:${decision}-${rule}`,
    kind: 'permission',
    source,
    intent: `${decision}: ${rule}`,
    trigger: { on: 'always' },
    blocking: decision === 'allow' ? 'observes' : 'blocks',
    needs: { resolution: 'facts', facts: ['tool_name'], evidence: 'declared' },
    sideEffects: [],
    rule,
    decision,
    enabled: true,
    order,
    raw: rule,
  };
}

const bash = (command: string): GatewayToolCall => ({
  id: 'call-1',
  name: 'Bash',
  arguments: { command },
});

const write = (filePath: string): GatewayToolCall => ({
  id: 'call-2',
  name: 'Write',
  arguments: { file_path: filePath },
});

/** Ворота плюс собранный исход: отказ виден в ответе, но след проверяется отдельно. */
function brokerWith(rules: readonly PermissionItem[], extra: Record<string, unknown> = {}) {
  const outcomes: PermissionOutcome[] = [];
  const gate = permissionBrokerOf({ rules, ...extra }, (outcome) => outcomes.push(outcome));
  return { gate, outcomes };
}

describe('правило решает судьбу вызова', () => {
  it('вызов, о котором канон молчит, брокер не трогает', async () => {
    const { gate, outcomes } = brokerWith([permission('Bash(git push:*)', 'deny')]);
    await expect(gate.decide(write('/tmp/a.txt'))).resolves.toEqual({ allow: true });
    expect(outcomes).toEqual([{ kind: 'unmatched' }]);
  });

  it('правило без уточнения ловит любой вызов этого инструмента', async () => {
    const { gate } = brokerWith([permission('Write', 'deny')]);
    const decision = await gate.decide(write('/tmp/a.txt'));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('«Write»');
  });

  it('уточнение `префикс:*` сравнивается с началом значения', async () => {
    const { gate } = brokerWith([permission('Bash(git push:*)', 'deny')]);
    await expect(gate.decide(bash('git push --force'))).resolves.toMatchObject({ allow: false });
    await expect(gate.decide(bash('git pull'))).resolves.toEqual({ allow: true });
  });

  it('уточнение без звёздочки — это точное совпадение, а не начало строки', async () => {
    const { gate } = brokerWith([permission('Bash(git push)', 'deny')]);
    await expect(gate.decide(bash('git push'))).resolves.toMatchObject({ allow: false });
    await expect(gate.decide(bash('git push --force'))).resolves.toEqual({ allow: true });
  });
});

describe('порядок решений, а не порядок строк', () => {
  it('`deny` сильнее `allow`, как бы они ни были записаны', async () => {
    const forward = brokerWith([
      permission('Bash(git push:*)', 'allow', 0),
      permission('Bash', 'deny', 1),
    ]);
    const backward = brokerWith([
      permission('Bash', 'deny', 0),
      permission('Bash(git push:*)', 'allow', 1),
    ]);
    for (const { gate } of [forward, backward]) {
      await expect(gate.decide(bash('git push --force'))).resolves.toMatchObject({ allow: false });
    }
  });

  it('`ask` сильнее `allow`: спрашивают, а не пропускают', async () => {
    const ask = vi.fn(async () => 'deny' as const);
    const { gate } = brokerWith([permission('Bash', 'ask'), permission('Bash(ls:*)', 'allow')], {
      ask,
    });
    await expect(gate.decide(bash('ls -la'))).resolves.toMatchObject({ allow: false });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('сравнить нечем — значит отказать', () => {
  it('уточнение есть, а поля для сравнения у вызова нет', async () => {
    const { gate, outcomes } = brokerWith([permission('Отправить(куда:*)', 'deny')]);
    const decision = await gate.decide({ id: 'c', name: 'Отправить', arguments: { куда: 'x' } });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('сравнить нечем');
    expect(outcomes[0]).toMatchObject({ kind: 'unmatchable' });
  });

  it('шаблон пути, который брокер не разбирает, тоже отказ, а не промах', async () => {
    const { gate, outcomes } = brokerWith([permission('Write(//srv/*/secret)', 'deny')]);
    await expect(gate.decide(write('/srv/a/secret'))).resolves.toMatchObject({ allow: false });
    expect(outcomes[0]).toMatchObject({ kind: 'unmatchable' });
  });

  it('запрет, который не удалось проверить, не уступает проверенному разрешению', async () => {
    const { gate, outcomes } = brokerWith([
      permission('Write', 'allow'),
      permission('Write(//srv/*/secret)', 'deny'),
    ]);
    await expect(gate.decide(write('/srv/a/secret'))).resolves.toMatchObject({ allow: false });
    expect(outcomes[0]).toMatchObject({ kind: 'unmatchable' });
  });
});

describe('`ask` на проводе — запрос, а не запрет', () => {
  it('человек разрешил — вызов уезжает', async () => {
    const { gate, outcomes } = brokerWith([permission('Bash', 'ask')], {
      ask: async () => 'allow' as const,
    });
    await expect(gate.decide(bash('ls'))).resolves.toEqual({ allow: true });
    expect(outcomes[0]).toMatchObject({ kind: 'asked', answer: 'allow' });
  });

  it('спрашивать некому — отказ с названной причиной, а не тихое разрешение', async () => {
    const { gate, outcomes } = brokerWith([permission('Bash', 'ask')]);
    const decision = await gate.decide(bash('ls'));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('спросить некому');
    expect(outcomes[0]).toMatchObject({ kind: 'ask_nobody' });
  });

  it('ответа не было — отказ по сроку, а не вечное ожидание', async () => {
    vi.useFakeTimers();
    try {
      const { gate, outcomes } = brokerWith([permission('Bash', 'ask')], {
        // Вопрос, на который никто никогда не ответит.
        ask: () => new Promise<'allow'>(() => {}),
        askTimeoutMs: 50,
      });
      const pending = gate.decide(bash('ls'));
      await vi.advanceTimersByTimeAsync(50);
      const decision = await pending;
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('ответа не было');
      expect(outcomes[0]).toMatchObject({ kind: 'ask_timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('срок по умолчанию задан числом, а не «когда-нибудь»', () => {
    expect(DEFAULT_ASK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('спрашивающий упал — это отказ, а не разрешение', async () => {
    const { gate } = brokerWith([permission('Bash', 'ask')], {
      ask: async () => {
        throw new Error('панель недоступна');
      },
    });
    await expect(gate.decide(bash('ls'))).resolves.toMatchObject({ allow: false });
  });
});

describe('режим подтверждений вызова не разбирает', () => {
  it('`mode:` правилом о вызове не становится', () => {
    expect(matchPermission([permission('mode:untrusted', 'deny')], bash('ls'))).toBeUndefined();
  });
});

describe('выключенное право не решает', () => {
  const off = (rule: string, decision: PermissionDecision): PermissionItem => ({
    ...permission(rule, decision),
    enabled: false,
  });

  it('снятый человеком запрет не запрещает', async () => {
    // Канон несёт выключенное право ради честного паспорта; запрети оно вызов —
    // отказ ссылался бы на правило, которого в настройках человека уже нет.
    expect(matchPermission([off('Bash(rm:*)', 'deny')], bash('rm -rf /'))).toBeUndefined();

    const { gate } = brokerWith([off('Bash(rm:*)', 'deny')]);
    await expect(gate.decide(bash('rm -rf /'))).resolves.toMatchObject({ allow: true });
  });

  it('действующее правило рядом с выключенным решает само', () => {
    const found = matchPermission(
      [off('Bash(rm:*)', 'allow'), permission('Bash(rm:*)', 'deny')],
      bash('rm -rf /'),
    );
    expect(found?.item.decision).toBe('deny');
    expect(found?.item.enabled).toBe(true);
  });
});

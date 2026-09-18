import { describe, it, expect } from 'vitest';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import { toolShimReport } from './tool-shim-report.ts';

/**
 * Сводка прослойки: что человек увидит в карточке «Инструменты через контур».
 *
 * Проверяется различимость двух исходов, которые снаружи выглядят одинаково
 * удачными: вызов состоялся — и вызова не было, но модель написала, что сделала.
 */

const event = (patch: Partial<PlatformGatewayEvent>): PlatformGatewayEvent => ({
  at: '2026-09-12T10:00:00.000Z',
  platformId: 'enterprise-platform',
  path: '/enterprise-platform/v1/messages',
  dialect: 'anthropic',
  status: 200,
  stages: [],
  summarized: false,
  violations: [],
  masked: false,
  blocked: false,
  interrupted: false,
  unknownFrames: [],
  lost: [],
  shimmed: ['tools', 'tool_choice'],
  toolCalls: 0,
  contourCalls: 0,
  toolFlaws: [],
  claimedWithoutCall: false,
  totalTokens: 0,
  ...patch,
});

describe('сводка прослойки инструментов', () => {
  it('считает ходы и вызовы порознь: ход вправе нести несколько', () => {
    const report = toolShimReport([
      event({ toolCalls: 2 }),
      event({ toolCalls: 1 }),
      event({ toolCalls: 0 }),
    ]);

    expect(report.requests).toBe(3);
    expect(report.turns).toBe(2);
    expect(report.calls).toBe(3);
  });

  it('заявка без вызова считается отдельно — ради неё сводка и заведена', () => {
    const report = toolShimReport([
      event({ claimedWithoutCall: true }),
      event({ toolCalls: 1 }),
      event({ claimedWithoutCall: true }),
    ]);

    expect(report.claimed).toBe(2);
    expect(report.turns).toBe(1);
  });

  it('запрос без инструментов в сводку не попадает вовсе', () => {
    // Обычный чат инструментов не звал: в знаменателе он только размывает
    // картину, а «прослойка ничего не собрала» про него — неправда.
    const report = toolShimReport([event({ shimmed: [] }), event({ toolCalls: 1 })]);
    expect(report.requests).toBe(1);
    expect(report.calls).toBe(1);
  });

  it('причины несостоявшихся вызовов складываются по одной строке', () => {
    const report = toolShimReport([
      event({ toolFlaws: ['инструмент не объявлен клиентом: Bash'] }),
      event({ toolFlaws: ['инструмент не объявлен клиентом: Bash', 'блок без закрывающего тега'] }),
    ]);

    // Рядом с причиной — её код: строка пришла из следа, а карточка читает её
    // на языке панели. Имя инструмента остаётся подстановкой, а не переводится.
    expect(report.flaws).toEqual([
      {
        reason: 'инструмент не объявлен клиентом: Bash',
        reasonCode: 'gateway-joined',
        reasonParams: { message: { messageCode: 'gateway-flaw-undeclared' }, detail: 'Bash' },
        count: 2,
      },
      {
        reason: 'блок без закрывающего тега',
        reasonCode: 'gateway-flaw-unclosed',
        count: 1,
      },
    ]);
  });

  it('чужой контур не считается, а начало отсчёта берётся от старого следа', () => {
    const report = toolShimReport(
      [
        event({ at: '2026-09-12T09:00:00.000Z', toolCalls: 1 }),
        event({ at: '2026-09-12T08:00:00.000Z', platformId: 'другой', toolCalls: 5 }),
      ],
      { platformIds: ['enterprise-platform'] },
    );

    expect(report.calls).toBe(1);
    expect(report.since).toBe('2026-09-12T09:00:00.000Z');
  });

  it('запросов не было — начала отсчёта нет, а не «ноль нарушений»', () => {
    const report = toolShimReport([]);
    expect(report.since).toBeUndefined();
    expect(report.requests).toBe(0);
  });
});

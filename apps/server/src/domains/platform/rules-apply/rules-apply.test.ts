import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import type { Platform, PlatformRulesApplies } from '@agentdeck/contracts';
import { driverFor } from '../drivers/index.ts';
import { runLayers } from '../layers/layers.ts';
import { toolRouteOf } from '../models/models.ts';
import { applyManagedRules, brokenExclusion, ruleConflicts } from '../rules-matrix/rules-matrix.ts';
import {
  effectiveOurRules,
  effectivePlatform,
  effectivePlatformRules,
  rulesApplies,
} from './rules-apply.ts';

/**
 * Выбор «чьи правила действуют» (баг 11б) и «кто берёт верх» в конфликте (11в).
 *
 * Один расчёт на шлюз, запуск и карточку — поэтому здесь проверяется не сама
 * функция выбора, а то, что её читают ВСЕ: сборка тела, путь инструментов,
 * снятие слоёв и матрица. Разойдись они, карточка обещала бы одно, а в контур
 * уезжало бы другое.
 */

const RULES = {
  platformTools: ['web_search'],
  toolMode: 'loop' as const,
  generationPreset: 'precise',
  enableThinking: 'on' as const,
};

function contour(applies?: PlatformRulesApplies | 'мусор', toolShim = false): Platform {
  return {
    id: 'company-dev',
    title: 'Company · dev',
    driver: 'enterprise-platform',
    baseUrl: 'https://api.dev.example.ru',
    enabled: true,
    mode: 'required',
    budgetUsd: 0,
    budgetSince: '',
    capabilities: [],
    targets: [],
    consumers: ['chat'],
    projectPaths: [],
    agents: [],
    toolShim,
    contourPrompt: true,
    defaultModel: '',
    consumerModels: {},
    modelMap: {},
    rules: {
      platform: RULES,
      ours: defaultOurRules(),
      ...(applies ? { applies: applies as PlatformRulesApplies } : {}),
    },
    caCertPath: '',
    transport: defaultPlatformTransport(),
  };
}

const enterprise = driverFor('enterprise-platform');
const OURS = { dlp: true, promptGate: true, toolShim: false, managedContext: true };

describe('чьи правила действуют', () => {
  it('нет поля или мусор — оба набора, запись не копируется', () => {
    expect(rulesApplies(contour())).toBe('both');
    expect(rulesApplies(contour('мусор'))).toBe('both');
    const both = contour('both');
    expect(effectivePlatform(both)).toBe(both);
  });

  it('«только наши»: правила контура — умолчания, наши слои как были', () => {
    const platform = contour('ours');
    expect(effectivePlatformRules(platform)).toEqual(defaultPlatformRules());
    expect(effectiveOurRules(platform)).toEqual(defaultOurRules());
    // Записанное не стирается: вернувшийся к «обоим» получит своё.
    expect(platform.rules.platform).toEqual(RULES);
  });

  it('«только контур»: наши слои сняты общим выключателем, правила контура целы', () => {
    const platform = contour('contour');
    expect(effectivePlatformRules(platform)).toEqual(RULES);
    expect(effectiveOurRules(platform).enabled).toBe(false);
    // Запуск снимает все четыре слоя — тем же расчётом, что и карточка.
    const dropped = runLayers(platform);
    expect([...dropped.dropped].sort()).toEqual(['mcp', 'settings', 'skills', 'systemPrompt']);
    expect(dropped.systemPrompt).toBe(false);
    expect(dropped.args.length).toBeGreaterThan(0);
    expect(runLayers(contour('both'))).toMatchObject({ args: [], dropped: [], systemPrompt: true });
  });

  it('тело запроса: «только наши» оставляет одно «инструментов не надо»', () => {
    expect(applyManagedRules({ model: 'm' }, contour('ours'), enterprise)).toEqual({
      model: 'm',
      tool_choice: 'none',
    });
    const both = applyManagedRules({ model: 'm' }, contour('both'), enterprise);
    expect(JSON.stringify(both)).toContain('web_search');
    expect(applyManagedRules({ model: 'm' }, contour('contour'), enterprise)).toEqual(both);
  });

  it('путь инструментов: без инструментов контура прослойка снова возможна', () => {
    expect(toolRouteOf(contour('both', true))).toBe(toolRouteOf(contour('contour', true)));
    expect(toolRouteOf(contour('ours', true))).toBe('shim');
  });

  it('взаимное исключение не запирает сохранение, когда сторона контура снята', () => {
    expect(brokenExclusion(contour('both', true), enterprise)?.id).toBe('tools');
    expect(brokenExclusion(contour('ours', true), enterprise)).toBeUndefined();
  });
});

describe('кто берёт верх (баг 11в)', () => {
  const cells = (applies?: PlatformRulesApplies) =>
    Object.fromEntries(
      ruleConflicts(contour(applies), enterprise, OURS).map((cell) => [cell.id, cell]),
    );

  it('у каждой ячейки назван победитель', () => {
    const all = cells();
    expect(all.tools?.winner).toBe('contour');
    expect(all.anonymization?.winner).toBe('both');
    expect(all.compaction?.winner).toBe('contour');
    expect(all.guardrails?.winner).toBe('both');
    expect(Object.values(all).every((cell) => cell.offBy === undefined)).toBe(true);
  });

  it('снятая выбором сторона названа — спора в прогоне нет', () => {
    const ours = cells('ours');
    expect(ours.tools?.offBy).toBe('contour');
    expect(ours.tools?.active).toBe(false);
    expect(ours.guardrails?.offBy).toBeUndefined();

    const theirs = cells('contour');
    expect(theirs.guardrails?.offBy).toBe('ours');
    expect(theirs.tools?.offBy).toBeUndefined();
    // Маска и сжатие истории выбором не снимаются: маска — защита, сжатие — у владельца.
    expect(theirs.anonymization?.offBy).toBeUndefined();
    expect(theirs.compaction?.offBy).toBeUndefined();
  });
});

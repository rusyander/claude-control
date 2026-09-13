import { describe, it, expect } from 'vitest';
import {
  PLATFORM_PRESETS,
  platformDrivers,
  platformManifestDeclared,
  platformManifestOf,
} from '@agentdeck/contracts/platform-presets';
import { defaultOurRules, defaultPlatformRules, type Platform } from '@agentdeck/contracts';
import { allDrivers, driverFor, driverOf } from './index.ts';
import { enterprise-platformDriver } from './enterprise-platform.ts';
import { openAiCompatDriver } from './openai-compat.ts';
import { contourHeaders } from '../transport.ts';
import { applyManagedRules } from '../rules-matrix.ts';
import { nativeMessagesPath } from '../gateway/anthropic-native.ts';

/**
 * Пресеты — драйвер данными (DRV-03). Проверяется не таблица сама с собой, а
 * то, что из данных собирается драйвер, по которому ходит панель: заголовок
 * ключа в запросе, ручка Anthropic в решении конвейера, поле размышлений в теле.
 */

function contour(fields: Partial<Platform>): Platform {
  return {
    id: 'c',
    title: 'c',
    driver: 'openai-compat',
    baseUrl: 'http://127.0.0.1:8000/v1',
    enabled: true,
    mode: 'required',
    budgetUsd: 0,
    budgetSince: '',
    capabilities: [],
    targets: [],
    consumers: [],
    projectPaths: [],
    agents: [],
    defaultModel: '',
    consumerModels: {},
    modelMap: {},
    toolShim: false,
    contourPrompt: false,
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    caCertPath: '',
    transport: { authHeader: '', authScheme: '', version: 'auto', query: '', headers: '' },
    ...fields,
  };
}

describe('пресеты: каждый собран и проверяется набором соответствия', () => {
  it('набор соответствия идёт по всем пресетам контракта, и только по ним', () => {
    expect(allDrivers.map((driver) => driver.id)).toEqual([...platformDrivers]);
  });

  it('код у пресета — код его базы: новый шлюз не приносит своего разборщика', () => {
    for (const id of platformDrivers) {
      const base = PLATFORM_PRESETS[id].base === 'enterprise-platform' ? enterprise-platformDriver : openAiCompatDriver;
      expect(driverFor(id).readFrame, id).toBe(base.readFrame);
      expect(driverFor(id).read, id).toBe(base.read);
    }
  });

  it('таблица «объявлено», которую показывает мастер, совпадает с собранным драйвером', () => {
    const overrides = [
      undefined,
      { anthropicMessages: '', imagesApi: 'images/generations', thinkingField: '' },
      { clientTools: 'shim' as const, effort: true, nonStreamTimeoutSec: 0 },
      { responseCeilingSec: 60 },
      { responseCeilingSec: 0 },
    ];
    for (const id of platformDrivers) {
      for (const patch of overrides) {
        const driver = driverFor(id, patch);
        const declared = platformManifestDeclared(id, patch);
        const thinking = driver.controls.find((control) => control.field === 'enableThinking');
        expect(
          {
            clientTools: driver.clientTools,
            effort: driver.effort,
            anthropicMessages: driver.anthropic?.messages ?? '',
            imagesApi: typeof driver.images === 'object' ? driver.images.api : '',
            imagesInChat: driver.images === 'chat-part',
            nonStreamTimeoutSec: driver.nonStreamTimeoutSec ?? 0,
            responseCeilingSec: driver.responseCeilingSec ?? 0,
            thinkingField: thinking ? (thinking.wireField ?? thinking.id) : '',
          },
          `${id} ${JSON.stringify(patch)}`,
        ).toEqual(declared);
      }
    }
  });

  it('незнакомое имя — совместимый шлюз, ничего не утверждающий', () => {
    expect(driverFor('litellm-2030')).toBe(driverFor('openai-compat'));
  });
});

describe('пресеты: объявленное доезжает до провода', () => {
  it('Azure — ключ в `api-key`, заголовка Authorization нет', () => {
    const headers = contourHeaders(contour({ driver: 'azure-openai' }), 'секрет');
    expect(headers['api-key']).toBe('секрет');
    expect(headers.authorization).toBeUndefined();
  });

  it('vLLM, LiteLLM, Ollama, OpenRouter — клиент Anthropic идёт к родной ручке', () => {
    for (const driver of ['vllm', 'litellm', 'ollama', 'openrouter'] as const) {
      const platform = contour({ driver });
      expect(nativeMessagesPath(platform, driverOf(platform)), driver).toBe('messages');
    }
    const compat = contour({ driver: 'openai-compat' });
    expect(nativeMessagesPath(compat, driverOf(compat))).toBeUndefined();
  });

  it('размышления уходят полем, которое объявил пресет', () => {
    const rules = {
      platform: { ...defaultPlatformRules(), enableThinking: 'on' as const },
      ours: defaultOurRules(),
    };
    const vllm = contour({ driver: 'vllm', rules });
    expect(applyManagedRules({ model: 'm' }, vllm, driverOf(vllm))).toEqual({
      model: 'm',
      chat_template_kwargs: { enable_thinking: true },
    });
    const dashscope = contour({ driver: 'dashscope', rules });
    expect(applyManagedRules({ model: 'm' }, dashscope, driverOf(dashscope))).toEqual({
      model: 'm',
      enable_thinking: true,
    });
    // Не объявившему — ничего: правило без механизма наверх не уходит.
    const compat = contour({ driver: 'openai-compat', rules });
    expect(applyManagedRules({ model: 'm' }, compat, driverOf(compat))).toEqual({ model: 'm' });
  });
});

describe('переопределения контура поверх пресета', () => {
  it('пустая строка снимает объявленное пресетом', () => {
    const driver = driverFor('vllm', { anthropicMessages: '', thinkingField: '' });
    expect(driver.anthropic).toBeUndefined();
    expect(driver.controls.some((control) => control.field === 'enableThinking')).toBe(false);
  });

  it('объявленное человеком появляется: ручка картинок, предел, инструменты, усилие', () => {
    const driver = driverFor('ollama', {
      imagesApi: 'images/generations',
      nonStreamTimeoutSec: 300,
      clientTools: 'shim',
      effort: true,
    });
    expect(driver.images).toEqual({ api: 'images/generations' });
    expect(driver.nonStreamTimeoutSec).toBe(300);
    expect(driver.clientTools).toBe('shim');
    expect(driver.effort).toBe(true);
    // Пресет при этом не тронут: сборка идёт на копии.
    expect(driverFor('ollama').images).toBe('none');
  });

  it('у платформа компании меняется только поле размышлений, подписи правила остаются её', () => {
    const own = enterprise-platformDriver.controls.find((control) => control.field === 'enableThinking')!;
    const moved = driverFor('enterprise-platform', { thinkingField: 'enable_thinking' }).controls.find(
      (control) => control.field === 'enableThinking',
    )!;
    expect(moved).toEqual({ ...own, wireField: 'enable_thinking' });
  });

  it('ноль снимает предел цельного ответа — действует потолок панели', () => {
    expect(driverFor('enterprise-platform').nonStreamTimeoutSec).toBeGreaterThan(0);
    expect(driverFor('enterprise-platform', { nonStreamTimeoutSec: 0 }).nonStreamTimeoutSec).toBeUndefined();
  });

  it('потолок ответа объявляется человеком для любого шлюза и снимается нулём', () => {
    // Шлюз за обратным прокси (nginx `proxy_read_timeout` 60 с) режет и поток —
    // без объявления обрыв на нём читался бы безымянным (MD-04).
    expect(driverFor('vllm').responseCeilingSec).toBeUndefined();
    expect(driverFor('vllm', { responseCeilingSec: 60 }).responseCeilingSec).toBe(60);
    expect(driverFor('enterprise-platform').responseCeilingSec).toBeGreaterThan(0);
    expect(driverFor('enterprise-platform', { responseCeilingSec: 0 }).responseCeilingSec).toBeUndefined();
    expect(platformManifestOf({ responseCeilingSec: -1 })).toEqual({});
  });

  it('негодные поля из записи, правленной руками, значат «как у пресета»', () => {
    const hostile = {
      anthropicMessages: '../admin',
      imagesApi: 'images/../../keys',
      thinkingField: '__proto__.polluted',
      nonStreamTimeoutSec: -5,
      clientTools: 'both',
      effort: 'да',
    };
    expect(platformManifestOf(hostile)).toEqual({});
    expect(driverFor('vllm', hostile)).toBe(driverFor('vllm'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('годное поле рядом с негодным остаётся', () => {
    expect(platformManifestOf({ anthropicMessages: 'v1/messages', thinkingField: 'a..b' })).toEqual(
      {
        anthropicMessages: 'v1/messages',
      },
    );
  });
});

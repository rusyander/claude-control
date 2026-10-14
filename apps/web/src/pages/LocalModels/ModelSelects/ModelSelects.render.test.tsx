import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChoiceOption, LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { catalogRows } from '@entities/LocalModels';
import { ModelSelects } from './ModelSelects';
import { contextLabel, contextOptionText, formatGb, quantOptionText } from './optionText';

/**
 * Два списка строки каталога. Причина закрытого варианта — цифрами и в тексте самого
 * варианта («не влезет: нужно 26,1 ГБ из 24»): нативный список показывает только его.
 */

const NBSP = '\u00a0';

const MODEL = {
  tag: 'qwen3.6:27b-coding',
  title: 'Qwen3.6 27B Coding',
  family: 'qwen3.6',
  coding: 'tuned',
  repo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  quants: [
    { id: 'Q4_K_M', file: 'q4.gguf', sizeBytes: 17_106_773_120 },
    { id: 'Q8_0', file: 'q8.gguf', sizeBytes: 28_000_000_000 },
  ],
  defaultQuant: 'Q4_K_M',
  arch: { layers: 64, kvLayers: 16, kvHeads: 4, headDim: 256 },
  sizeBytes: 17_106_773_120,
  paramsB: 27,
  activeParamsB: 27,
  kvBytesPerToken: 65_536,
  contextMax: 262_144,
  mtp: false,
  agentic: true,
  custom: false,
  released: '2026-04',
  source: '',
};

function rowHtml(
  choice: { quant: string; context: number },
  allowPartial = false,
  ramGb = 95,
  freeGb = 22.2,
  withGpu = true,
): string {
  const info = {
    hardware: {
      gpus: withGpu
        ? [
            {
              vendor: 'nvidia',
              name: 'RTX 4090',
              vramGb: 24,
              freeGb,
              bandwidthGbs: 1008,
              bandwidthFrom: 'table',
            },
          ]
        : [],
      ramGb,
      platform: 'linux',
      arch: 'x64',
      detectedBy: '',
    },
    catalog: { version: 1, checkedAt: '2026-10', models: [MODEL] },
    installed: [],
    importable: [],
    jobs: [],
    connect: { model: '' },
    device: 'gpu',
    choices: { [MODEL.tag]: { ...choice, allowPartial } },
  } as unknown as LocalModelsInfo;
  const row = catalogRows(info)[0];
  if (!row) throw new Error('no row');
  return renderToStaticMarkup(<ModelSelects row={row} onChoose={() => undefined} />);
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('ModelSelects: две подписанные группы на каждой строке', () => {
  it('оба списка подписаны, группа названа моделью', () => {
    const html = rowHtml({ quant: 'Q4_K_M', context: 65_536 });
    expect(html).toContain('aria-label="Квантование и контекст Qwen3.6 27B Coding"');
    expect(html).toContain('>Квантование</label>');
    expect(html).toContain('>Контекст</label>');
    expect((html.match(/<select/g) ?? []).length).toBe(2);
  });

  it('выбор показан выбранным: квантование Q4_K_M, окно 64K', () => {
    const html = rowHtml({ quant: 'Q4_K_M', context: 65_536 });
    expect(html).toMatch(/<option value="Q4_K_M" selected/);
    expect(html).toMatch(/<option value="65536" selected/);
  });

  it('при Q4_K_M и 256K Q8_0 закрыт с цифрами; окно меньше 32K закрыто «агенту мало»', () => {
    const html = rowHtml({ quant: 'Q4_K_M', context: 262_144 });
    expect(html).toMatch(
      /<option value="Q8_0" disabled="">[^<]*не влезет: нужно [\d,]+\u00a0ГБ из 22,2/,
    );
    expect(html).toMatch(/<option value="8192" disabled="">8K · агенту мало: меньше 32K/);
  });

  it('тумблер частичной выгрузки появляется там, где что-то влезает только частично', () => {
    // Q8_0 при 64K: 22 ГБ весов не лезут в 22,2 вместе с кешем — частично.
    expect(rowHtml({ quant: 'Q8_0', context: 65_536 }, true)).toContain(
      'aria-label="Частично в оперативной памяти"',
    );
    // Памяти для частичной выгрузки нет вовсе — тумблер ничего бы не открыл.
    expect(rowHtml({ quant: 'Q4_K_M', context: 65_536 }, false, 2)).not.toContain(
      'Частично в оперативной памяти',
    );
  });
});

describe('рекомендация под эту машину', () => {
  it('выбрано не рекомендуемое: подпись под списками, «Применить», у вариантов — «рекомендуется»', () => {
    const html = rowHtml({ quant: 'Q8_0', context: 32_768 });
    expect(html).toContain(`Для вашей видеокарты (22,2${NBSP}ГБ): Q4_K_M · 64K`.replace(NBSP, ' '));
    expect(html).toContain('>Применить<');
    expect(html).toMatch(/<option value="Q4_K_M">[^<]*рекомендуется/);
    expect(html).toMatch(/<option value="65536"[^>]*>64K · рекомендуется/);
  });

  it('выбрано рекомендуемое: «Выбрано рекомендуемое…» без кнопки', () => {
    const html = rowHtml({ quant: 'Q4_K_M', context: 65_536 });
    expect(html).toContain('Выбрано рекомендуемое для вашей видеокарты (22,2 ГБ): Q4_K_M · 64K');
    expect(html).not.toContain('>Применить<');
    // Выбранное в поле — коротко, без пометок: отметка стоит в подписи под списками.
    expect(html).not.toMatch(/<option value="Q4_K_M" selected="">[^<]*рекомендуется/);
  });

  it('без видеокарты считает оперативная память — и подпись про неё', () => {
    const html = rowHtml({ quant: 'Q8_0', context: 32_768 }, false, 128, 22.2, false);
    expect(html).toContain('Для вашей оперативной памяти (');
    expect(html).not.toContain('Для вашей видеокарты');
  });

  it('ничего не лезет целиком даже на 32K — так и сказано, кнопки нет', () => {
    const html = rowHtml({ quant: 'Q4_K_M', context: 65_536 }, false, 8, 6);
    expect(html).toContain('ничего не помещается даже при 32K');
    expect(html).not.toContain('>Применить<');
  });
});

describe('подписи вариантов', () => {
  const noFit: ChoiceOption<string> = {
    value: 'BF16',
    sizeBytes: 26 * 1024 ** 3,
    needGb: 26.14,
    availableGb: 24,
    level: 'none',
    partial: false,
    disabled: true,
    block: 'too-big',
  };

  it('«не влезет: нужно 26,1 ГБ из 24» — десятичная запятая в русском, точка в английском', async () => {
    const ru = quantOptionText(noFit, false, i18n.getFixedT('ru'), 'ru');
    expect(ru).toContain(`не влезет: нужно 26,1${NBSP}ГБ из 24`);
    await i18n.changeLanguage('en');
    const en = quantOptionText(noFit, true, i18n.getFixedT('en'), 'en');
    await i18n.changeLanguage('ru');
    expect(en).toContain(`does not fit: needs 26.1${NBSP}GB of 24`);
    expect(en).toContain('downloaded');
  });

  it('скачанное помечено; окно — K и M', () => {
    const ok: ChoiceOption<string> = { ...noFit, disabled: false, level: 'gpu' };
    delete (ok as { block?: string }).block;
    expect(quantOptionText(ok, true, i18n.getFixedT('ru'), 'ru')).toContain('скачано');
    expect(contextLabel(65_536)).toBe('64K');
    expect(contextLabel(1_048_576)).toBe('1M');
    expect(contextLabel(49_152)).toBe('48K');
    const small: ChoiceOption<number> = {
      value: 8_192,
      needGb: 1,
      availableGb: 24,
      level: 'gpu',
      partial: false,
      disabled: true,
      block: 'agent-min',
    };
    expect(contextOptionText(small, i18n.getFixedT('ru'), 'ru')).toBe(
      '8K · агенту мало: меньше 32K',
    );
    expect(formatGb(19.55, 'ru')).toBe('19,6');
  });

  it('файл из Ollama: настоящее квантование и источник, не служебная метка; у выбранного — коротко', () => {
    const ollama: ChoiceOption<string> = {
      ...noFit,
      value: 'Ollama',
      label: 'Q4_K_M',
      source: 'ollama',
      sizeBytes: 15.7 * 1024 ** 3,
      disabled: false,
      level: 'gpu',
    };
    delete (ollama as { block?: string }).block;
    const t = i18n.getFixedT('ru');
    expect(quantOptionText(ollama, true, t, 'ru')).toBe(
      `Q4_K_M${NBSP}· 15,7${NBSP}ГБ · перенесён из Ollama`,
    );
    expect(quantOptionText(ollama, true, t, 'ru', true)).toBe(`Q4_K_M${NBSP}· 15,7${NBSP}ГБ`);
    // Закрытый выбранный вариант в поле без причины: причина — отдельной строкой под списками.
    expect(quantOptionText(noFit, true, t, 'ru', true)).not.toContain('не влезет');
  });
  it('рекомендуется, низкое качество и неизвестное квантование из Ollama — словами, не «Ollama»', () => {
    const t = i18n.getFixedT('ru');
    const low: ChoiceOption<string> = {
      ...noFit,
      value: 'Q2_K',
      disabled: false,
      level: 'gpu',
    };
    delete (low as { block?: string }).block;
    expect(quantOptionText(low, false, t, 'ru')).toContain('низкое качество');
    expect(quantOptionText(low, false, t, 'ru', false, true)).toContain('рекомендуется');
    const unknown: ChoiceOption<string> = { ...low, value: 'Ollama', source: 'ollama' };
    const text = quantOptionText(unknown, true, t, 'ru');
    expect(text).toContain('неизвестное квантование');
    expect(text).toContain('перенесён из Ollama');
    expect(text).not.toMatch(/^Ollama/);
    const ctx: ChoiceOption<number> = {
      value: 65_536,
      needGb: 1,
      availableGb: 24,
      level: 'gpu',
      partial: false,
      disabled: false,
    };
    expect(contextOptionText(ctx, t, 'ru', false, true)).toBe('64K · рекомендуется');
  });
});

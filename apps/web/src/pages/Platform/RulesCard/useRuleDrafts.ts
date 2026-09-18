import { useState } from 'react';
import type { Platform } from '@agentdeck/contracts';
import { parseToolNames, platformRules } from '../lib/rulesView';

export interface RuleDrafts {
  /** Недописанный список инструментов контура — строкой, как в поле. */
  tools: string;
  setTools: (value: string) => void;
  /** Недописанный пресет генерации. */
  preset: string;
  setPreset: (value: string) => void;
  /** Поля отличаются от сохранённого — кнопке «Применить» есть что записать. */
  toolsChanged: boolean;
  presetChanged: boolean;
}

/**
 * Черновики двух текстовых правил контура: инструменты и пресет.
 *
 * Поля ввода следуют за ответом сервера: тот же контур правят с телефона, из
 * другой вкладки и мастером, и кнопка «Сохранить» предлагала бы записать
 * старое значение поверх нового. Состояние заводится заново, когда приехало
 * ДРУГОЕ сохранённое значение, — недописанная строка человека этим не
 * стирается (ревью Т7, m5).
 */
export function useRuleDrafts(platform: Platform): RuleDrafts {
  const current = platformRules(platform);
  const stored = current.platformTools.join(', ');
  const [tools, setTools] = useState(stored);
  const [preset, setPreset] = useState(current.generationPreset);

  const [seen, setSeen] = useState({ tools: stored, preset: current.generationPreset });
  if (seen.tools !== stored || seen.preset !== current.generationPreset) {
    setSeen({ tools: stored, preset: current.generationPreset });
    if (seen.tools !== stored) setTools(stored);
    if (seen.preset !== current.generationPreset) setPreset(current.generationPreset);
  }

  /** Изменения полей ввода применяются кнопкой: сохранять на каждую букву незачем. */
  const toolsChanged = parseToolNames(tools).join(', ') !== stored;
  const presetChanged = preset.trim() !== current.generationPreset;

  return { tools, setTools, preset, setPreset, toolsChanged, presetChanged };
}

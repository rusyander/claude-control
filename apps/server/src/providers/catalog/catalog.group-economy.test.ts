import { describe, it, expect } from 'vitest';
import {
  GROUP_ECONOMY_LEVERS,
  groupEconomySupportSchema,
  leverWorks,
} from '@agentdeck/contracts/group-economy-support';
import { listProviders } from '../registry.ts';

/**
 * @covers catalog/{gemini,goose,continue,kimi,opencode,aider,cursor}.ts
 * @scenario семь CLI пакета D объявляют каждый из шести рычагов; недействующий
 *   — с причиной; канал есть ровно у тех, у кого родной рычаг доходит до прогона
 *   (Goose, Continue), у Gemini его нет — файл настроек на прогон CLI отвергает.
 */

const PACKAGE_D = ['gemini', 'goose', 'continue', 'kimi', 'opencode', 'aider', 'cursor'];
const byId = (id: string) => listProviders().find((provider) => provider.id === id);

describe('catalog group economy (package D)', () => {
  it('every lever declared; muted ones carry a reason', () => {
    for (const id of PACKAGE_D) {
      const economy = byId(id)?.groupEconomy;
      expect(economy, id).toBeDefined();
      const support = economy!.support;
      expect(groupEconomySupportSchema.parse(support), id).toEqual(support);
      expect(Object.keys(support).sort(), id).toEqual([...GROUP_ECONOMY_LEVERS].sort());
      for (const lever of GROUP_ECONOMY_LEVERS) {
        const entry = support[lever]!;
        // Действующий — подсказка по желанию (условие), недействующий — всегда.
        if (!leverWorks(entry)) expect(entry.note, `${id}.${lever}`).toMatch(/^economy-note-/);
      }
    }
  });

  it('goose: working levers name their condition (review D F1, F2)', () => {
    const support = byId('goose')!.groupEconomy!.support;
    // Порог сжатия — только когда окно модели известно (`gooseEconomy` в `apps/core/src/adapters/economy-carry.ts`).
    expect(support.compactWindow).toEqual({
      support: 'native',
      note: 'economy-note-window-known-only',
    });
    // Один ключ на все инструменты, действует больший из двух рычагов.
    for (const lever of ['bashOutputChars', 'readOutputTokens'] as const) {
      expect(support[lever], lever).toEqual({
        support: 'native',
        note: 'economy-note-shared-tool-limit-larger',
      });
    }
  });

  it('kimi: implicit cache, config-only limits; aider: no TTL key, habits meaningless', () => {
    const kimi = byId('kimi')!.groupEconomy!.support;
    expect(kimi.cacheTtl).toEqual({ support: 'impossible', note: 'economy-note-cache-implicit' });
    expect(kimi.compactWindow).toEqual({
      support: 'disproportionate',
      note: 'economy-note-config-only',
    });
    const aider = byId('aider')!.groupEconomy!.support;
    expect(aider.cacheTtl).toEqual({ support: 'impossible', note: 'economy-note-no-key' });
    expect(aider.workHabits).toEqual({ support: 'meaningless', note: 'economy-note-no-tool-loop' });
  });

  it('channel only where a native lever reaches the run', () => {
    const channels = Object.fromEntries(
      PACKAGE_D.map((id) => [id, byId(id)?.groupEconomy?.channel ?? null]),
    );
    expect(channels).toEqual({
      gemini: null,
      goose: 'goose',
      continue: 'continue',
      kimi: null,
      opencode: null,
      aider: null,
      cursor: null,
    });
    for (const id of PACKAGE_D) {
      const economy = byId(id)!.groupEconomy!;
      const native = GROUP_ECONOMY_LEVERS.filter(
        (lever) => economy.support[lever]?.support === 'native',
      );
      // Родной рычаг без канала был бы обещанием, которое прогон не выполняет.
      expect(native.length > 0, id).toBe(Boolean(economy.channel));
    }
  });

  it('gemini declares both settings keys disproportionate and its channel stays empty', () => {
    const support = byId('gemini')!.groupEconomy!.support;
    expect(support.compactWindow).toEqual({
      support: 'disproportionate',
      note: 'economy-note-admin-settings',
    });
    expect(support.bashOutputChars).toEqual(support.compactWindow);
    // Канал рычагов на прогон теперь у ядра (`economy-carry.ts`); здесь — что каталог его не объявляет.
    expect(byId('gemini')!.groupEconomy!.channel).toBeUndefined();
  });
});

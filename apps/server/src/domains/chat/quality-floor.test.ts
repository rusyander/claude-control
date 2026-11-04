import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';
import {
  labelledCut,
  NARROWING_PHRASES,
  OWNER_PRECEDENCE_LINE,
  OWNER_PRECEDENCE_PLAIN_LINE,
  SKILL_ROUTE_LINE,
  withoutPrecedence,
} from '@agentdeck/contracts/quality-floor';
import { buildGroupPrompt, parseSplitProposal } from '@agentdeck/contracts/task-split';

/**
 * Нижняя планка заданий панели (владелец, 12.10.2026: «группа может только
 * ДОБАВИТЬ качество»). Одна таблица на все построители первых сообщений:
 *
 * - слова владельца доходят целиком — метка в 50 тыс. знаков стоит в задании
 *   без единой потери;
 * - ни одна фраза, которая однажды уже сузила работу (`NARROWING_PHRASES`), в
 *   обёртку панели не вернулась;
 * - строка старшинства стоит ровно один раз — вложенное задание группы её уже
 *   несёт, и построитель поверх не повторяет;
 * - ни одна длинная строка не повторена: повтор стоит токенов в каждом ходе.
 *
 * Новый построитель первого сообщения — новая строка таблицы; без неё он
 * планку не проходил.
 */

const OWNER = `OWNER-START ${'Сделай аккуратно, проверь всё. '.repeat(1_700)} OWNER-END`;
const OWNER_B = `SECOND-START ${'Проверь документацию и локали. '.repeat(400)} SECOND-END`;

const GROUP = { title: 'Группа', branch: 'feat/a', tasks: [OWNER, OWNER_B] };
const GROUP_TASK = buildGroupPrompt(GROUP, 'Общий контекст разделения.');
const HANDOFF = {
  done: 'Этап закрыт',
  next: 'Дальше — второй этап',
  checkpoint: '.agent/PROGRESS.md',
};

const BUILDERS: { name: string; prompt: string; owner: string[] }[] = [
  { name: 'buildGroupPrompt', prompt: GROUP_TASK, owner: [OWNER, OWNER_B] },
  {
    name: 'buildHandoffPrompt (group)',
    prompt: buildHandoffPrompt(HANDOFF, GROUP_TASK, { group: true }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'buildHandoffPrompt',
    prompt: buildHandoffPrompt(HANDOFF, OWNER),
    owner: [OWNER],
  },
];

/** Обёртка панели без слов владельца: сужение ищется только в её строках. */
function panelPart(prompt: string, owner: readonly string[]): string {
  return owner.reduce((text, words) => text.split(words).join(' '), prompt);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('планка заданий панели', () => {
  describe.each(BUILDERS)('$name', ({ prompt, owner }) => {
    it('слова владельца доходят целиком', () => {
      for (const words of owner) expect(prompt).toContain(words);
      expect(prompt).not.toContain('cut by the panel');
    });

    it('обёртка не сужает задание', () => {
      const panel = panelPart(prompt, owner);
      const hits = NARROWING_PHRASES.filter((phrase) => phrase.test(panel)).map(String);
      expect(hits).toEqual([]);
    });

    // Две формы (F-57): с исключением о расписании проверок и без него.
    it('строка старшинства — ровно одна', () => {
      expect(
        count(prompt, OWNER_PRECEDENCE_LINE) + count(prompt, OWNER_PRECEDENCE_PLAIN_LINE),
      ).toBe(1);
    });

    it('строка навыков — не больше одной', () => {
      expect(count(prompt, SKILL_ROUTE_LINE)).toBeLessThanOrEqual(1);
    });

    it('ни одна длинная строка не повторена', () => {
      const lines = panelPart(prompt, owner)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 60);
      const repeated = lines.filter((line, index) => lines.indexOf(line) !== index);
      expect(repeated).toEqual([]);
    });
  });

  it('задание группы называет навык по роду работы — над строкой старшинства (U12)', () => {
    expect(count(GROUP_TASK, SKILL_ROUTE_LINE)).toBe(1);
    expect(GROUP_TASK.indexOf(SKILL_ROUTE_LINE)).toBeLessThan(
      GROUP_TASK.indexOf(OWNER_PRECEDENCE_PLAIN_LINE),
    );
    for (const skill of [
      'deep-review',
      'resolving-merge-conflicts',
      'unit-integration-tests',
      'log-forensics',
    ]) {
      expect(SKILL_ROUTE_LINE).toContain(skill);
    }
  });

  it('разбор предложения разделения не режет задачу и общий контекст', () => {
    const parsed = parseSplitProposal({
      shared: OWNER_B,
      groups: [
        { title: 'Раз', tasks: [OWNER] },
        { title: 'Два', tasks: ['коротко'] },
      ],
    });
    expect(parsed?.shared).toBe(OWNER_B);
    expect(parsed?.groups[0]?.tasks[0]).toBe(OWNER);
  });
});

/**
 * F-57: исключение «полный прогон проверок — расписание панели, раз на группу, в
 * доставке» правдиво только там, где звено доставки есть. Одиночный чат и правки
 * без доставки получали его же — и полный прогон не делал никто.
 * F-62b: «никогда не форсить, кроме своей ветки» вместо «не пушить голым --force».
 * F-124: старые формы строки (до обновления) снимаются так же, как новые.
 */
describe('строка старшинства: форма по наличию доставки', () => {
  const SCHEDULE = "that is the panel's schedule (once per group, at delivery)";

  it('без доставки — строка без исключения о расписании', () => {
    expect(OWNER_PRECEDENCE_PLAIN_LINE).not.toContain(SCHEDULE);
    expect(OWNER_PRECEDENCE_PLAIN_LINE).not.toContain('\n');
    const single = buildHandoffPrompt(HANDOFF, OWNER);
    expect(single).toContain(OWNER_PRECEDENCE_PLAIN_LINE);
    expect(single).not.toContain(SCHEDULE);
  });

  it('с доставкой — полная строка', () => {
    const delivered = buildGroupPrompt(GROUP, 'Общий контекст разделения.', { deliver: true });
    expect(delivered).toContain(OWNER_PRECEDENCE_LINE);
    expect(buildHandoffPrompt(HANDOFF, GROUP_TASK, { group: true, deliver: true })).toContain(
      SCHEDULE,
    );
  });

  /**
   * RF-BGCD-06: группа без доставки (ChatSplit с `deliver=false`) и её продолжение
   * получали то же обещание «правило о полном прогоне выполнит доставка», а
   * звена доставки у неё нет — полный прогон не делал никто.
   */
  it('группа без доставки и её продолжение — строка без исключения о расписании', () => {
    expect(GROUP_TASK).toContain(OWNER_PRECEDENCE_PLAIN_LINE);
    expect(GROUP_TASK).not.toContain(SCHEDULE);
    const next = buildHandoffPrompt(HANDOFF, GROUP_TASK, { group: true });
    expect(next).toContain(OWNER_PRECEDENCE_PLAIN_LINE);
    expect(next).not.toContain(SCHEDULE);
  });

  it('свою ветку форсить можно, остальные — никогда', () => {
    for (const line of [OWNER_PRECEDENCE_LINE, OWNER_PRECEDENCE_PLAIN_LINE]) {
      expect(line).toContain('never force-push any branch but your own');
      expect(line).not.toContain('bare --force');
    }
  });

  it('снимаются все формы, включая записанные до обновления', () => {
    const legacyFixed =
      'Fixed regardless of anything: never merge, approve or resolve threads, never push with a bare --force, and a read-only stage edits no code.';
    const legacyFull = OWNER_PRECEDENCE_LINE.replace(
      /Fixed regardless of anything:.*$/,
      legacyFixed,
    );
    const legacyPlain = OWNER_PRECEDENCE_PLAIN_LINE.replace(
      /Fixed regardless of anything:.*$/,
      legacyFixed,
    );
    expect(legacyFull).not.toBe(OWNER_PRECEDENCE_LINE);
    for (const form of [
      OWNER_PRECEDENCE_LINE,
      OWNER_PRECEDENCE_PLAIN_LINE,
      legacyFull,
      legacyPlain,
    ]) {
      expect(withoutPrecedence(`Задание.\n\n${form}\n\nХвост.`)).toBe('Задание.\n\nХвост.');
    }
  });
});

describe('обрезка с меткой', () => {
  it('в пределах потолка текст не трогается', () => {
    expect(labelledCut(OWNER, OWNER.length)).toBe(OWNER);
  });

  it('сверх потолка — метка с обоими числами, а не молчание', () => {
    const cut = labelledCut('абвгд', 3);
    expect(cut.startsWith('абв')).toBe(true);
    expect(cut).toContain('cut by the panel at 3 of 5 chars');
  });
});

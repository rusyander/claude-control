import { describe, it, expect } from 'vitest';
import {
  planSections,
  stageContextBlock,
  STAGE_ARTIFACTS_MAX,
} from '@agentdeck/contracts/model-cascade';
import {
  OWNER_PRECEDENCE_LINE,
  ownerRequestBlock,
  SKILL_ROUTE_LINE,
} from '@agentdeck/contracts/quality-floor';
import { planCascadeStage } from './ChatCascadeStages.ts';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Диета заданий звеньев (L2.1–L2.3, L7.4, журнал 19.10): ревью, правки и
 * доставка получали план целиком (28 тыс. знаков), правки — ещё и до 24 тыс.
 * знаков хвоста ответа ревью, и всё это лежало в контексте каждого хода до
 * сжатия. Размеры здесь — числа, а не «стало меньше»: иначе тест не отличил бы
 * диету от лишней строки.
 */

const line = (label: string, index: number): string =>
  `- ${label} ${index}: ${'подробность шага с файлами и строками '.repeat(2).trim()}`;
const block = (label: string, count: number): string =>
  Array.from({ length: count }, (_, index) => line(label, index)).join('\n');

/** План той формы, что пишет звено плана (`planStagePrompt`): разделы 1–8 заголовками. */
const PLAN = [
  '# План группы «Переименования»',
  '## 1. Анализ кода',
  block('АНАЛИЗ', 60),
  '## 2. Образцы в репозитории',
  block('ОБРАЗЕЦ', 25),
  '## 3. Подходы',
  block('ПОДХОД', 25),
  '## 4. Шаги',
  // Голая нумерация внутри шагов — не заголовок раздела, даже с «критериями».
  '5. Проверить критерии приёмки после шага 4',
  block('ШАГ', 100),
  '## 5. Критерии приёмки',
  '- КРИТЕРИЙ-А: foo не встречается нигде',
  block('КРИТЕРИЙ', 10),
  '## 6. Уровень проверки',
  '- ПРОВЕРКА-Б: vitest по затронутым файлам',
  '## 7. Не трогать',
  '- ГРАНИЦА-В: миграции',
  '## 8. Открытые вопросы',
  '- РЕШЕНИЕ-Г: старое имя оставить алиасом',
].join('\n');

const OWNER = ownerRequestBlock(['Переименуй foo в bar везде, проверки — живьём на стенде.'])!;
/** Задание группы так, как его кладёт разделение (`ChatSplit`: без строки старшинства). */
const GROUP_TASK = [OWNER, '1. Переименуй foo в bar', SKILL_ROUTE_LINE].join('\n\n');
const PLAN_PATH = '.agent/plans/group-plan-abc.agent.md';
const ARTIFACTS = [
  'e2e/screenshots/before-after/rename/',
  '.agent/tickets/PROJ-1.agent.md',
  '.agent/tests/runs/20261019-1.run.json',
  '.agent/tmp/gates.log',
];
/** Ответ ревьюера: проза вокруг блока, которую раньше получали правки целиком. */
const REVIEW_PROSE = `Ревьюер разбирает дифф по шагам.\n${block('ПРОЗА-РЕВЬЮ', 150)}`;
const FINDING = '🔴 1 **foo остался** — b.ts:3-3; `grep foo b.ts` → 1 строка; должно быть 0';

function link(patch: Partial<ChatLink> = {}): ChatLink {
  return {
    parentChatId: 'parent',
    createdAt: '2026-10-19T00:00:00.000Z',
    branch: 'split/rename',
    model: 'sonnet',
    effort: 'medium',
    kind: 'mechanical',
    lowered: true,
    stage: 'work',
    ceilingModel: 'claude-opus-5',
    ceilingEffort: 'high',
    task: GROUP_TASK,
    groupTask: GROUP_TASK,
    planSummary: PLAN,
    ...patch,
  };
}

interface Files {
  planFile?: (plan: string) => string | undefined;
  artifacts?: () => readonly string[];
}

const withFiles: Files = { planFile: () => PLAN_PATH, artifacts: () => ARTIFACTS };

function stage(patch: Partial<ChatLink>, text: string, files: Files = withFiles) {
  return planCascadeStage({
    link: link(patch),
    ok: true,
    text,
    task: 'задание прогона',
    hasWork: () => true,
    deliver: true,
    now: () => new Date('2026-10-19T01:00:00.000Z'),
    ...files,
  });
}

const reviewText = (findings: string[]): string =>
  [REVIEW_PROSE, '```agentdeck:review', JSON.stringify({ findings }), '```'].join('\n');

/** Четыре звена после работы: ревью, правки, проверка правок, доставка. */
function stages(files: Files = withFiles) {
  return {
    review: stage({}, 'Сделал: переименовал в 12 файлах.', files),
    fix: stage(
      { stage: 'review', model: 'claude-opus-5', lowered: false, workModel: 'sonnet' },
      reviewText([FINDING]),
      files,
    ),
    verify: stage({ stage: 'fix', fixFindings: [FINDING] }, 'Поправил b.ts.', files),
    deliver: stage(
      { stage: 'review', fixFindings: [FINDING], model: 'claude-opus-5' },
      reviewText([]),
      files,
    ),
  };
}

const sizeOf = (prompt: string | undefined): number => prompt?.length ?? 0;
const count = (text: string | undefined, part: string): number =>
  (text ?? '').split(part).length - 1;

describe('planSections: разрез плана перед §5 (L2.1)', () => {
  it('режет по заголовку §5 и не путает его с пунктом шагов', () => {
    const sections = planSections(PLAN);
    expect(sections).toBeDefined();
    expect(sections!.tail.startsWith('## 5. Критерии приёмки')).toBe(true);
    expect(sections!.head).toContain('5. Проверить критерии приёмки после шага 4');
    // Ничего не потеряно: начало и конец вместе — весь план.
    expect(`${sections!.head}\n${sections!.tail}`).toBe(PLAN);
  });

  it('узнаёт жирные и §-заголовки, английские названия', () => {
    const bold = PLAN.replace(/^## (\d)\. (.*)$/gm, '**$1. $2**').replace(
      'Критерии приёмки',
      'Acceptance criteria',
    );
    expect(planSections(bold)?.tail.startsWith('**5. Acceptance criteria**')).toBe(true);
    const sign = PLAN.replace(/^## (\d)\. /gm, '§$1 ');
    expect(planSections(sign)?.tail.startsWith('§5 Критерии приёмки')).toBe(true);
  });

  it('сомнительное — целым планом: нет разделов, голая нумерация, сбитый порядок, короткое начало', () => {
    expect(planSections('1. Найти foo\n2. Заменить на bar')).toBeUndefined();
    expect(planSections(PLAN.replace(/^## /gm, ''))).toBeUndefined();
    expect(planSections(PLAN.replace('## 6. Уровень', '## 3. Уровень'))).toBeUndefined();
    expect(planSections(PLAN.replace('## 5. Критерии приёмки', '## 5. Итог'))).toBeUndefined();
    const short = '## 1. Анализ\nкоротко\n## 5. Критерии приёмки\n- А';
    expect(planSections(short)).toBeUndefined();
  });
});

describe('звенья после работы: план, хвост ревью, задание, артефакты', () => {
  it('ревью, правки, проверка и доставка: §5–§8 текстом, §0–§4 — путём (L2.1)', () => {
    for (const [name, staged] of Object.entries(stages())) {
      const prompt = staged?.prompt ?? '';
      expect(prompt, name).toContain('КРИТЕРИЙ-А');
      expect(prompt, name).toContain('ПРОВЕРКА-Б');
      expect(prompt, name).toContain('ГРАНИЦА-В');
      expect(prompt, name).toContain('РЕШЕНИЕ-Г');
      expect(prompt, name).toContain(`plan file ${PLAN_PATH}`);
      expect(prompt, name).toContain('read its §4 only if a step is unclear');
      expect(prompt, name).not.toContain('АНАЛИЗ 0');
      expect(prompt, name).not.toContain('ШАГ 0');
    }
  });

  it('нет файла плана — план целиком в каждом звене, ни один раздел не теряется', () => {
    let asked = 0;
    const all = stages({
      planFile: () => {
        asked += 1;
        return undefined;
      },
    });
    for (const [name, staged] of Object.entries(all)) {
      expect(staged?.prompt, name).toContain('АНАЛИЗ 0');
      expect(staged?.prompt, name).toContain('ШАГ 99');
      expect(staged?.prompt, name).toContain('РЕШЕНИЕ-Г');
      expect(staged?.prompt, name).not.toContain('plan file');
    }
    expect(asked).toBeGreaterThan(0);
  });

  it('план без разделов файла не получает: писать его незачем', () => {
    let asked = 0;
    const staged = stage({ planSummary: '1. Найти foo\n2. Заменить на bar' }, 'Сделал.', {
      planFile: () => {
        asked += 1;
        return PLAN_PATH;
      },
    });
    expect(staged?.stage).toBe('review');
    expect(staged?.prompt).toContain('2. Заменить на bar');
    expect(staged?.prompt).not.toContain('plan file');
    expect(asked).toBe(0);
  });

  it('работа после плана получает план целиком, файл не спрашивается', () => {
    let asked = 0;
    const planLink = link({ stage: 'plan', workModel: 'sonnet' });
    delete planLink.planSummary;
    const staged = planCascadeStage({
      link: planLink,
      ok: true,
      text: ['```agentdeck:plan', PLAN, '```'].join('\n'),
      task: 'план',
      hasWork: () => true,
      planFile: () => {
        asked += 1;
        return PLAN_PATH;
      },
      artifacts: () => ARTIFACTS,
    });
    expect(staged?.stage).toBe('work');
    expect(staged?.prompt).toContain('АНАЛИЗ 0');
    expect(staged?.prompt).toContain('ШАГ 99');
    expect(asked).toBe(0);
  });

  it('правки — замечания карточками, без 24 тыс. знаков прозы ревью (L2.2)', () => {
    const { fix } = stages();
    expect(fix?.stage).toBe('fix');
    expect(fix?.prompt).toContain(`1. ${FINDING}`);
    expect(fix?.prompt).not.toContain('ПРОЗА-РЕВЬЮ');
    expect(fix?.prompt).not.toContain('Outcome of the previous stage');
    // Проверка правок по-прежнему видит отчёт правок: по нему она и сверяет.
    expect(stages().verify?.prompt).toContain('Поправил b.ts.');
  });

  it('слова владельца — в каждом звене; строка навыков — только где звено не называет свой (L2.3)', () => {
    const all = stages();
    for (const [name, staged] of Object.entries(all)) {
      expect(staged?.prompt, name).toContain('Переименуй foo в bar везде, проверки — живьём');
      expect(count(staged?.prompt, OWNER_PRECEDENCE_LINE), name).toBe(1);
    }
    expect(all.review?.prompt).not.toContain(SKILL_ROUTE_LINE);
    expect(all.deliver?.prompt).not.toContain(SKILL_ROUTE_LINE);
    // Правки и проверка своего навыка не называют — подсказка остаётся.
    expect(all.fix?.prompt).toContain(SKILL_ROUTE_LINE);
    expect(all.verify?.prompt).toContain(SKILL_ROUTE_LINE);
  });

  it('звенья после работы видят артефакты прошлых звеньев путями (L7.4)', () => {
    for (const [name, staged] of Object.entries(stages())) {
      expect(staged?.prompt, name).toContain('Artifacts the earlier stages left in this copy');
      for (const path of ARTIFACTS) expect(staged?.prompt, name).toContain(`- ${path}`);
    }
    const many = Array.from({ length: 15 }, (_, index) => `.agent/tmp/gate-${index}.log`);
    const block = stageContextBlock({ artifacts: many });
    expect(count(block, '\n- ')).toBe(STAGE_ARTIFACTS_MAX);
    expect(stageContextBlock({ artifacts: [] })).toBe('');
  });

  it('размеры: план ≈ на начало меньше, правки ещё и без прозы ревью', () => {
    const lean = stages();
    const whole = stages({ planFile: () => undefined });
    const head = planSections(PLAN)!.head.length;
    const saved = Object.fromEntries(
      Object.keys(lean).map((name) => [
        name,
        sizeOf(whole[name as keyof typeof whole]?.prompt) -
          sizeOf(lean[name as keyof typeof lean]?.prompt),
      ]),
    );
    // Каждое звено после работы экономит начало плана за вычетом строки ссылки
    // (и артефактов — они есть в обоих наборах).
    for (const [name, value] of Object.entries(saved)) {
      expect(value, name).toBeGreaterThan(head - 600);
    }
    expect(head).toBeGreaterThan(15_000);
    // Правки: проза ревью (≈13 тыс. знаков здесь) не едет совсем.
    expect(sizeOf(lean.fix?.prompt)).toBeLessThan(PLAN.length - head + 6_000);
    expect(REVIEW_PROSE.length).toBeGreaterThan(10_000);
  });
});

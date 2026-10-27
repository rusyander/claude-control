import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_PICK_MARKER,
  autonomousPickMessage,
  type RecommendedPick,
} from '@agentdeck/contracts/chat-group-settings';
import { recommendedPicks } from '../chat/auto-pick/auto-pick.ts';
import { builtinKitDir } from './service.ts';

/**
 * Хук набора `autonomous-pick` отвечает на вопрос там, где брокера панели нет
 * (полный доступ), и обязан выбрать РОВНО то, что выбрал бы брокер
 * (`recommendedPicks`), и написать РОВНО тот текст, по которому лента узнаёт
 * автовыбор (`autonomousPickMessage`). Копия правил в `.mjs` — значит, сверка
 * по корпусу: подписи и описания из тестов группы «по плану» (они растут вместе
 * с правилами) плюс свои. Последний блок — настоящий процесс диспетчера набора,
 * как его зовёт `hooks.json`.
 */

const HOOKS = join(builtinKitDir(), 'hooks');
const lib = (await import(pathToFileURL(join(HOOKS, 'lib', 'autonomous-pick.mjs')).href)) as {
  recommendedPicks: (input: unknown) => RecommendedPick[] | null;
  pickMessage: (picks: readonly RecommendedPick[]) => string;
};

/** Строковые литералы `label:` / `description:` из тестов группы — живой корпус. */
function corpusTexts(): string[] {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'chat', 'group-questions', 'group-questions.test.ts'),
    'utf8',
  );
  const found = [...source.matchAll(/(?:label|description):\s*'((?:[^'\\]|\\.)*)'/g)].map((match) =>
    match[1]!.replace(/\\'/g, "'"),
  );
  return [
    ...found,
    'Safe (Recommended)',
    'Вправо (рекомендую)',
    "we don't recommend this",
    'Not ideal but recommended',
    'не очень рекомендую',
    "I'll log in (Recommended)",
    'Session refreshed — continue (Recommended)',
    'Mark as fixed (Recommended)',
    'Option i: recommended',
    'Сессия не обновлена — рекомендую подождать',
    'Токен доступа обновлён',
    'Keep the snapshot updated (recommended)',
  ];
}

function corpusInputs(): unknown[] {
  const texts = corpusTexts();
  const inputs: unknown[] = [];
  texts.forEach((text, index) => {
    const other = texts[(index + 7) % texts.length]!;
    inputs.push({
      questions: [{ question: `Q${index}`, options: [{ label: 'Plain' }, { label: text }] }],
    });
    inputs.push({
      questions: [
        {
          question: `D${index}`,
          header: 'critical',
          options: [{ label: 'A' }, { label: 'B', description: text }],
        },
      ],
    });
    inputs.push({
      questions: [
        { question: `M${index}`, options: [{ label: text }, { label: other }] },
        { question: 'second', options: [{ label: 'Yes (Recommended)' }] },
      ],
    });
  });
  inputs.push(null, {}, { questions: [] }, { questions: [null] }, { questions: [{ options: [] }] });
  return inputs;
}

describe('autonomous-pick набора = выбор брокера панели', () => {
  it('на всём корпусе выбор хука совпадает с recommendedPicks', () => {
    const inputs = corpusInputs();
    expect(inputs.length).toBeGreaterThan(100);
    let picked = 0;
    for (const input of inputs) {
      const server = recommendedPicks(input);
      expect(lib.recommendedPicks(input), JSON.stringify(input)).toEqual(server);
      if (server) picked += 1;
    }
    // Корпус проверяет обе стороны: и выбор, и отказ от выбора.
    expect(picked).toBeGreaterThan(20);
    expect(inputs.length - picked).toBeGreaterThan(20);
  });

  it('текст отказа — байт в байт текст контракта, с той же меткой', () => {
    const picks: RecommendedPick[] = [
      { question: 'Путь\n"кавычки" → ?', label: 'Надёжный (Recommended)', critical: true },
      { question: 'Second', label: 'B', critical: false },
    ];
    expect(lib.pickMessage(picks)).toBe(autonomousPickMessage(picks));
    expect(lib.pickMessage(picks).startsWith(`${AUTONOMOUS_PICK_MARKER}:`)).toBe(true);
  });
});

describe('autonomous-pick через диспетчер набора (lib/run.mjs pre)', () => {
  const DISPATCH = join(HOOKS, 'lib', 'run.mjs');
  const QUESTION = {
    questions: [
      { question: 'Path?', options: [{ label: 'Fast' }, { label: 'Safe (Recommended)' }] },
    ],
  };
  const run = (mode: string, env: NodeJS.ProcessEnv) => {
    const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: QUESTION,
        permission_mode: mode,
        session_id: 'kit-autopick',
      }),
      encoding: 'utf8',
      env: { ...process.env, AGENTDECK_AUTONOMOUS: '', AGENTDECK_SPLIT_CHILD: '', ...env },
      timeout: 15_000,
    });
    const text = out.stdout.trim();
    return text
      ? (
          JSON.parse(text) as {
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          }
        ).hookSpecificOutput
      : undefined;
  };

  it('полный доступ под автономией — отказ с выбором в формате панели', () => {
    const out = run('bypassPermissions', { AGENTDECK_AUTONOMOUS: '1' });
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toBe(
      autonomousPickMessage([{ question: 'Path?', label: 'Safe (Recommended)', critical: false }]),
    );
  });

  it('брокер подключён или автономии нет — решения нет: отвечает брокер или человек', () => {
    expect(run('default', { AGENTDECK_AUTONOMOUS: '1' })?.permissionDecision).toBeUndefined();
    expect(run('bypassPermissions', {})?.permissionDecision).toBeUndefined();
  });
});

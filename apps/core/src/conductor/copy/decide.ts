import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CopyCreateFailed,
  CopySetupDecision,
  CopySetupInput,
  CopySetupVerdict,
  InstallRun,
  LeftBehind,
  SetupStage,
} from './copy.types.ts';
import { firstErrorLine } from './log.ts';

/**
 * Судья класса `copy-setup` (00 §Decision classes, P01): один на класс. Провал этапа шаг не
 * останавливает и не прячет (04:99): решение `failed` несёт этап, хвост лога и первую строку
 * ошибки — дирижёр кладёт их в задание шага. Всё, что копия не получила, — строка на единице
 * (04:98). Неизвестный факт этапа — не «всё хорошо», а пробел с причиной (F25).
 */

function reasonOf<T>(fact: Fact<T>): string {
  if ('unknown' in fact) return fact.unknown;
  if ('absent' in fact) return 'absent';
  return '';
}

function installWhy(run: InstallRun): string {
  if (run.refused) return `refused: ${run.refused}`;
  if (run.timedOut)
    return `stopped after ${Math.round(run.ms / 1000)} s${run.leftover ? ` (${run.leftover})` : ''}`;
  return `exit ${run.exit ?? 'none'}`;
}

export function decideCopySetup(input: CopySetupInput | CopyCreateFailed): CopySetupDecision {
  if ('createFailed' in input) {
    const tail = input.createFailed;
    // Хвост создания — строка вызова git и его stderr: первая ошибка — строка `fatal:` git, а не
    // «Command failed: <вся командная строка>».
    const firstError = /^fatal: .+$/m.exec(tail)?.[0] ?? firstErrorLine(tail);
    return {
      verdict: 'failed',
      envPrepared: false,
      leftBehind: [{ kind: 'copy', subject: 'unit copy', why: `not created: ${tail}` }],
      failure: { stage: 'create', tail, ...(firstError ? { firstError } : {}) },
      brief: [
        'Copy setup: failed (environment not prepared by the core).',
        `Failed at create: ${tail}`,
      ],
    };
  }
  const left: LeftBehind[] = [];
  const failures: { stage: SetupStage; tail: string; firstError?: string }[] = [];
  const fail = (stage: SetupStage, tail: string, firstError?: string): void => {
    failures.push({ stage, tail, ...(firstError ? { firstError } : {}) });
  };

  // Зеркало: не прочиталось — копия без локального слоя, это провал этапа, а не тишина.
  if ('value' in input.mirror) {
    const m = input.mirror.value;
    for (const path of m.unlisted)
      left.push({ kind: 'unlisted', subject: path, why: 'ignored and not in the mirror list' });
    for (const path of m.built)
      left.push({
        kind: 'build-env',
        subject: path,
        why: 'build environment: installed, never copied',
      });
    for (const skip of m.skipped)
      left.push({ kind: 'mirror-skip', subject: skip.path, why: skip.why });
    for (const path of m.flagsFailed)
      left.push({ kind: 'git-flag', subject: path, why: 'git flag not set in the copy' });
  } else {
    const why = reasonOf(input.mirror);
    left.push({ kind: 'mirror-skip', subject: 'local layer', why: `mirror not done: ${why}` });
    fail('mirror', `mirror: ${why}`);
  }

  // Окружение: снятые переменные названы (адрес не-эфемерной базы копия не держит никогда).
  let envOk = false;
  if ('value' in input.env) {
    envOk = true;
    for (const c of input.env.value) {
      if (c.action === 'removed')
        left.push({ kind: 'env-var', subject: `${c.file}:${c.name}`, why: c.why });
    }
  } else {
    left.push({
      kind: 'env',
      subject: '.env files',
      why: `env rewrite not done: ${reasonOf(input.env)}`,
    });
  }

  for (const note of input.plan.notes)
    left.push({ kind: 'install-note', subject: note.subject, why: note.why });

  let installOk = true;
  if (input.plan.unread) {
    installOk = false;
    left.push({ kind: 'install', subject: 'dependencies', why: input.plan.unread });
    fail('install', `install plan: ${input.plan.unread}`);
  }
  for (const run of input.installs) {
    const cmd = `${run.step.command} ${run.step.args.join(' ')}`.trim();
    const where = run.step.root || '.';
    if (run.exit === 0 && !run.timedOut && !run.refused) continue;
    installOk = false;
    const why = installWhy(run);
    left.push({ kind: 'install', subject: `${cmd} in ${where}`, why });
    fail('install', run.tail || `${cmd}: ${why}`, run.firstError);
  }
  // Отложенная установка — не провал: копия оценки только читает; названо, что зависимостей нет.
  if (input.deferred && !input.plan.unread) {
    installOk = false;
    const planned = input.plan.steps.map((s) => `${s.command} ${s.args.join(' ')}`.trim());
    left.push({
      kind: 'install',
      subject: 'dependencies',
      why: `deferred until the first step that edits the copy${planned.length > 0 ? ` (${planned.join('; ')})` : ''}`,
    });
  }

  if ('value' in input.reverted) {
    for (const path of input.reverted.value)
      left.push({ kind: 'lockfiles', subject: path, why: 'rewritten by install, reverted' });
  } else {
    left.push({
      kind: 'lockfiles',
      subject: 'lock files',
      why: `revert not read: ${reasonOf(input.reverted)}`,
    });
  }

  if (!('value' in input.longPaths)) {
    left.push({ kind: 'longpaths', subject: 'core.longpaths', why: reasonOf(input.longPaths) });
  }

  // Откаченный lock-файл — не пробел: копия чистая, это сказано для лога, а не как недостача.
  const gaps = left.filter((item) => !(item.kind === 'lockfiles' && 'value' in input.reverted));
  // Первая причина важнее второй: вторая часто следствие первой.
  const first = failures[0];
  let failure: CopySetupDecision['failure'];
  if (first) {
    // Ошибка установки — из всего её вывода (F-173); у прочих этапов хвост и есть весь текст.
    const firstError = first.firstError ?? firstErrorLine(first.tail);
    failure = { stage: first.stage, tail: first.tail, ...(firstError ? { firstError } : {}) };
  }
  let verdict: CopySetupVerdict = gaps.length > 0 ? 'ready-with-gaps' : 'ready';
  if (failure) verdict = 'failed';
  const envPrepared = envOk && installOk && !failure;

  const brief: string[] = [
    `Copy setup: ${verdict}${envPrepared ? '' : ' (environment not prepared by the core)'}.`,
  ];
  if (failure) {
    brief.push(`Failed at ${failure.stage}${failure.firstError ? `: ${failure.firstError}` : ''}.`);
    brief.push(`Log tail:\n${failure.tail}`);
  }
  for (const item of gaps) brief.push(`Not in the copy: ${item.subject} — ${item.why}.`);

  return {
    verdict,
    envPrepared,
    leftBehind: left,
    ...(failure ? { failure } : {}),
    brief,
    ...(input.deferred ? { installDeferred: true as const } : {}),
  };
}

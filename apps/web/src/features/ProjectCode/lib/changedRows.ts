import type {
  ProjectFileChange,
  ProjectGitChange,
  ProjectGitFileStatus,
} from '@agentdeck/contracts';

/**
 * Что показать в списке «Изменённые» — правки агента и изменения рабочего дерева
 * одним перечнем.
 *
 * Двух источников здесь не избежать, и они отвечают на разные вопросы. Правки
 * агента считаются по транскрипту разговора: это «что натворил ОН», с числом
 * строк, и они есть даже у файла, который потом закоммитили. Рабочее дерево —
 * ответ git на «что вообще не как в HEAD», включая правки человека, прошлых
 * разговоров и терминала. Раньше окно показывало только первый источник, и в
 * свежем чате открывалось со словами «изменений нет» над репозиторием с
 * двумя десятками правленых файлов — ровно то, ради чего в него и заходили.
 *
 * Порядок намеренный: сначала этот разговор, потом остальное. Один и тот же
 * файл не двоится — строка агента забирает себе состояние git (M, ?? и так
 * далее), поэтому видно и сколько строк он тронул, и что правка ещё не в
 * коммите.
 */
export interface ChangedRow {
  /** Путь от корня проекта, разделители — прямые слэши (как отдаёт и git). */
  path: string;
  /** Чей это ответ: правки разговора или состояние рабочего дерева. */
  source: 'agent' | 'git';
  /** Строк добавлено и убрано — только у правок агента. */
  added?: number;
  removed?: number;
  /** Агент правил файл, а на диске его уже нет: открыть нечего. */
  missing?: boolean;
  /** Состояние по git, если файл виден и ему. */
  status?: ProjectGitFileStatus;
  /** Правка уже в индексе. */
  staged?: boolean;
}

export function changedRows(
  agent: ProjectFileChange[] | undefined,
  git: ProjectGitChange[] | undefined,
): ChangedRow[] {
  const byPath = new Map<string, ProjectGitChange>();
  for (const change of git ?? []) byPath.set(change.path, change);

  const rows: ChangedRow[] = [];
  const seen = new Set<string>();

  for (const change of agent ?? []) {
    const status = byPath.get(change.path);
    seen.add(change.path);
    rows.push({
      path: change.path,
      source: 'agent',
      added: change.added,
      removed: change.removed,
      ...(change.missing ? { missing: true } : {}),
      ...(status ? { status: status.status, staged: status.staged } : {}),
    });
  }

  for (const change of git ?? []) {
    if (seen.has(change.path)) continue;
    rows.push({
      path: change.path,
      source: 'git',
      status: change.status,
      staged: change.staged,
    });
  }

  return rows;
}

/** Первый файл, который можно открыть: удалённого на диске нет. */
export function firstOpenable(rows: ChangedRow[]): string | undefined {
  return rows.find((row) => !row.missing && row.status !== 'deleted')?.path;
}

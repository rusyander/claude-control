/** Звено пути группы и сколько раз подряд оно шло. */
export interface StageStep {
  stage: string;
  count: number;
}

/**
 * Путь группы без повторов подряд (владелец 22.10.2026): «план › работа ›
 * работа › работа» читался кашей, и текущее звено терялось в конце. Подряд
 * идущие одинаковые звенья — одним шагом со счётом.
 */
export function stageTrack(stages: readonly string[]): StageStep[] {
  const track: StageStep[] = [];
  for (const stage of stages) {
    const last = track.at(-1);
    if (last?.stage === stage) last.count += 1;
    else track.push({ stage, count: 1 });
  }
  return track;
}

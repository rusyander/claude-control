import type { ProjectTestBaseline } from '@agentdeck/contracts';

/** Выбранная точка: пропавшая заменяется первой, чтобы окно не пустело. */
export function pickPoint(
  points: ProjectTestBaseline[],
  pointId: string,
): ProjectTestBaseline | undefined {
  return points.find((point) => point.pointId === pointId) ?? points[0];
}

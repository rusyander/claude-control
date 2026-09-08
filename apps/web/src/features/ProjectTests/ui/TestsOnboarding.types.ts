import type { TestsBoard } from '../model/useTestsBoard';

export interface TestsOnboardingProps {
  board: TestsBoard;
  /** Пожелание агенту из пульта: генерация отсюда должна уйти с тем же текстом. */
  scope: string;
  environmentId: string;
}

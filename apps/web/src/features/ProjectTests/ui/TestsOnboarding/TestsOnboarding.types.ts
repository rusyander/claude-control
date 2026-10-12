import type { DraftBox } from '@shared/lib/draft';
import type { TestsBoard } from '../../model/useTestsBoard';

export interface TestsOnboardingProps {
  board: TestsBoard;
  /** Пожелание агенту из пульта: генерация отсюда должна уйти с тем же текстом. */
  scope: DraftBox;
  environmentId: string;
}

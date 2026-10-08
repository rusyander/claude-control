import type { TestsBoard } from '../../model/useTestsBoard';

export interface TestE2eCardProps {
  board: TestsBoard;
  /** Окружение пульта прогона: с ним запускаются автотесты папки. */
  environmentId?: string;
}

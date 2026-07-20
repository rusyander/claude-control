import type { SandboxKind } from '@entities/Sandbox';
import type { TestContext } from '../model/buildTestPrompt';

export interface SandboxChatProps {
  sandboxId: string;
  kind: SandboxKind;
  title: string;
  context?: Omit<TestContext, 'title'>;
}

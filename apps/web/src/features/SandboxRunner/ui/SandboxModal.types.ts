import type { SandboxKind, SandboxSelection } from '@entities/Sandbox';
import type { TestContext } from '../model/buildTestPrompt';

/** Способ проверки: прямой прогон или разговор. */
export type Tab = 'probe' | 'chat';

export interface SandboxModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Что проверяем — от этого зависит доступный вид проверки. */
  kind: SandboxKind;
  /** Название для заголовка. */
  title: string;
  /** Состав песочницы. */
  selection: SandboxSelection;
  /** Идентификатор сервера — нужен стенду MCP. */
  mcpId?: string;
  /** Имя файла скрипта — нужно прогону скрипта без привязки к хуку. */
  scriptName?: string;
  /** Идентификатор хука — нужен прогону по заготовкам. */
  hookId?: string;
  /**
   * Данные самой настройки: из них собираются готовые запросы для проверки.
   * Без них чипы будут общими и по-настоящему ничего не проверят.
   */
  context?: Omit<TestContext, 'title'>;
}

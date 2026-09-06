import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { ErrorBoundaryProps, ErrorBoundaryState } from './error-boundary.types';

/**
 * Граница ошибок. Исключение в любом компоненте без неё снимает ВСЁ дерево:
 * React 19 не оставляет ни навигации, ни поля ввода — только пустоту или голое
 * «Something went wrong!» роутера. Границ несколько, и у каждой своя мера:
 * приложение целиком (сбой провайдера), раздел (роутер), одно сообщение ленты
 * (битые данные транскрипта не должны прятать остальную переписку).
 *
 * Класс, а не хук: у React по-прежнему нет хука для перехвата ошибок рендера.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override readonly state: ErrorBoundaryState = { error: undefined, failed: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // В консоли — место сбоя словами: стек компонентов React длинный, а имя
    // границы говорит сразу, что именно отвалилось.
    console.error(
      `[claude-control] сбой отрисовки: ${this.props.scope ?? 'компонент'}`,
      error,
      info.componentStack,
    );
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: undefined, failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === 'function' ? fallback(this.state.error, this.reset) : fallback;
  }
}

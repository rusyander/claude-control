/** Что обёртка движка знает о себе: настоящий argv движка и каталог сессии (журнал вызовов). */
export interface ContainerWrapSpec {
  real: string[];
  /** Нет — спецификация прежнего вида (массив argv): вызовы без метки не записываются, это названо. */
  dir?: string;
}

/**
 * Строка `container-calls.jsonl` (G18): вызов, чьи контейнеры не несут метку задачи. `null` в
 * списке id — движок не ответил; поиск в конце шага называет это непрочитанным, а не пустым.
 */
export type ContainerCall =
  | {
      v: 1;
      at: number;
      engine: 'docker' | 'podman';
      kind: 'compose-project';
      project: string;
      /** Контейнеры проекта ДО вызова: они не ресурс задачи и не снимаются. */
      before: string[] | null;
    }
  | {
      v: 1;
      at: number;
      engine: 'docker' | 'podman';
      kind: 'created-during';
      containers: string[] | null;
      pods: string[] | null;
    };

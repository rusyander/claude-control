import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFileChange, ProjectFileContent } from '@claude-control/contracts';
import { useProjectChanges, useProjectFile, useSaveProjectFile } from '@entities/ProjectFile';
import { useCodeView } from './useCodeView';

/**
 * Состояние окна кода: какой файл открыт, что в нём набрано и показывать ли
 * дифф.
 *
 * Что именно открыто (файл, раскрытые папки, режимы показа) держит и помнит
 * между открытиями `useCodeView` — эта память живёт на сервере и привязана к
 * табу проекта. Здесь остаётся работа с самим файлом: загрузка, черновик,
 * запись.
 *
 * Черновик живёт в ref, а не в состоянии, специально: набор текста идёт по
 * букве, и состояние перерисовывало бы вместе с редактором всё дерево файлов.
 * Наружу выходит только признак «есть несохранённое» — он меняется дважды за
 * правку, а не на каждом нажатии.
 */
export function useProjectCode(
  projectPath: string | undefined,
  chatId: string | undefined,
  isOpen: boolean,
) {
  const [isDirty, setDirty] = useState(false);
  const draft = useRef('');

  /**
   * Несохранённые правки по всем файлам, тронутым за это открытие окна.
   *
   * Переключение файла их не теряет — как во всяком редакторе с вкладками:
   * человек уходит посмотреть соседний файл и возвращается к своей работе, а не
   * к тому, что лежало на диске. Наружу отдаётся список путей: по нему окно
   * спрашивает перед закрытием, а не выбрасывает работу молча.
   */
  const drafts = useRef(new Map<string, string>());
  const [dirtyFiles, setDirtyFiles] = useState<string[]>([]);

  const changes = useProjectChanges(isOpen ? projectPath : undefined, chatId);
  const save = useSaveProjectFile(projectPath, chatId);

  const changed = useMemo(() => {
    const map = new Map<string, ProjectFileChange>();
    for (const entry of changes.data?.files ?? []) {
      if (!entry.missing) map.set(entry.path, entry);
    }
    return map;
  }, [changes.data]);

  // Все каталоги на пути к изменённым файлам. Считается здесь, а не в дереве:
  // ветка знает только своих детей, а пометить надо и деда, и прадеда — иначе
  // папку с правками не видно, пока не раскроешь всё до неё.
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of changed.keys()) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        dirs.add(parts.slice(0, index).join('/'));
      }
    }
    return dirs;
  }, [changed]);

  const view = useCodeView(projectPath, isOpen, changedDirs);
  const selected = view.selected;
  const file = useProjectFile(isOpen ? projectPath : undefined, selected, chatId);

  // Загрузился файл — черновик начинается от того, что лежит на диске. Кроме
  // случая, когда по этому файлу уже есть НЕсохранённая правка: она сделана
  // человеком, и молча стереть её переключением на соседний файл нельзя.
  const loaded = file.data;
  useEffect(() => {
    const kept = loaded ? drafts.current.get(loaded.path) : undefined;
    draft.current = kept ?? loaded?.content ?? '';
    setDirty(kept !== undefined);
  }, [loaded?.path, loaded?.mtimeMs, loaded?.content, loaded]);

  // Последний ДОШЕДШИЙ файл. Пока грузится следующий, на экране остаётся он:
  // запрос между кликом и ответом отдаёт `undefined`, и без этой памяти
  // редактор на каждом переключении опустошался бы и собирался заново.
  const [shown, setShown] = useState<ProjectFileContent | undefined>(undefined);
  useEffect(() => {
    if (loaded) setShown(loaded);
  }, [loaded]);

  // Ничего не открыто и открывать нечего из памяти — показываем первый
  // изменённый файл: за ним в это окно и приходят. Только после восстановления
  // снимка, иначе подстановка перебила бы запомненный выбор.
  useEffect(() => {
    if (!isOpen || !view.isHydrated || selected) return;
    const first = changes.data?.files.find((entry) => !entry.missing);
    if (first) view.select(first.path);
    // `view.select` — сеттер состояния, он стабилен.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, view.isHydrated, selected, changes.data]);

  // Закрыли окно — забываем черновики: следующий раз открывается от того, что
  // лежит на диске, а не с чужой недописанной правкой. Спросить успели раньше,
  // на самом закрытии.
  useEffect(() => {
    if (isOpen) return;
    setShown(undefined);
    setDirty(false);
    setDirtyFiles([]);
    drafts.current.clear();
    draft.current = '';
  }, [isOpen]);

  /**
   * Текущий набранный текст. Нужен показу SVG и разметки: он рисуется из того,
   * что в редакторе, а не из того, что на диске, — иначе вкладка «Превью»
   * показывала бы файл до правки, которую как раз и хотят увидеть.
   */
  const readDraft = (): string => draft.current;

  /** Правка по конкретному файлу — ею открывается редактор при возврате. */
  const draftOf = (path: string): string | undefined => drafts.current.get(path);

  const changeDraft = (value: string): void => {
    draft.current = value;
    const path = loaded?.path;
    if (!path) return;

    // Вернули текст к тому, что на диске, — правки больше нет: держать её в
    // списке значило бы спрашивать перед закрытием ни о чём.
    if (value === loaded?.content) drafts.current.delete(path);
    else drafts.current.set(path, value);

    setDirty(drafts.current.has(path));
    setDirtyFiles([...drafts.current.keys()]);
  };

  const isEditable = Boolean(loaded && !loaded.isBinary && !loaded.tooBig && !loaded.isReadOnly);

  const saveDraft = (): void => {
    if (!selected || !loaded || !isEditable || !isDirty) return;

    save.mutate(
      { file: selected, content: draft.current, mtimeMs: loaded.mtimeMs },
      {
        onSuccess: () => {
          drafts.current.delete(selected);
          setDirty(false);
          setDirtyFiles([...drafts.current.keys()]);
        },
      },
    );
  };

  /** Отказаться от всего набранного — по явному ответу человека, не иначе. */
  const dropDrafts = (): void => {
    drafts.current.clear();
    draft.current = loaded?.content ?? '';
    setDirty(false);
    setDirtyFiles([]);
  };

  return {
    selected,
    select: view.select,
    openDirs: view.openDirs,
    toggleDir: view.toggleDir,
    file,
    /** Файл, который сейчас в редакторе, — может отставать от `selected`. */
    shown,
    /** Ждём другой файл: показанный уже не тот, что выбран. */
    isSwitching: Boolean(selected) && shown?.path !== selected,
    changes,
    changed,
    changedDirs,
    showDiff: view.showDiff,
    setShowDiff: view.setShowDiff,
    onlyChanged: view.onlyChanged,
    setOnlyChanged: view.setOnlyChanged,
    isDirty,
    /** Файлы с несохранённой правкой — о них окно спрашивает перед закрытием. */
    dirtyFiles,
    isEditable,
    isSaving: save.isPending,
    readDraft,
    draftOf,
    changeDraft,
    saveDraft,
    dropDrafts,
  };
}

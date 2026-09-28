import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { rovingTarget } from '@shared/lib/roving';
import styles from './instruction-files.module.scss';
import type { InstructionFilesCardProps } from './instruction-files.types';

/**
 * Какой файл инструкций читает сам CLI, а какой лежит рядом непрочитанным.
 *
 * С 2.1.277 имя файла — не константа: ключ `instructionFiles` выбирает между
 * `CLAUDE.md`, `AGENTS.md`, обоими сразу и «ни одним». Панель ничего не
 * переименовывает и второго файла не заводит — она ПОКАЗЫВАЕТ раскладку, потому
 * что оставшийся рядом `CLAUDE.md` у CLI молча побеждает `AGENTS.md`, и решение
 * об имени принадлежит человеку, а не нам.
 *
 * Выбор имени предлагается ровно в одном случае — файла ещё нет на диске.
 */
export function InstructionFilesCard({
  view,
  chosenName,
  onChooseName,
  className,
}: InstructionFilesCardProps) {
  const { t } = useTranslation();
  const offerChoice = view.proposed && onChooseName !== undefined && view.choices.length > 1;
  // Карточек на странице может быть две (правила проекта рядом с общими) —
  // подпись группы у каждой своя, иначе обе группы называла бы первая.
  const labelId = `${useId()}-name-label`;
  const choiceRefs = useRef(new Map<string, HTMLButtonElement>());
  // Остановка Tab одна на группу — у выбранного имени; выбранного нет среди
  // вариантов — у первого, иначе в группу не попасть с клавиатуры вовсе.
  const tabStop =
    chosenName !== undefined && view.choices.includes(chosenName) ? chosenName : view.choices[0];

  /**
   * Радиогруппа по образцу ARIA: стрелки/Home/End переводят фокус и сразу
   * выбирают имя (ревью 28.09, F-244 — роль обещала стрелки, а каждая кнопка
   * была своим шагом Tab и стрелки не работали).
   */
  const handleChoiceKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const focused = (event.target as HTMLElement).dataset.choice ?? tabStop;
    const next = rovingTarget(view.choices, focused, event.key);
    if (next === undefined || !onChooseName) return;
    event.preventDefault();
    onChooseName(next);
    choiceRefs.current.get(next)?.focus();
  };

  return (
    <Card padding="sm" className={cn(styles.root, className)}>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="info" size={18} />
          <Typography variant="body-sm" color="muted">
            {t(`instructionFiles.mode.${view.mode}`)}
            {view.source !== 'default' && ` · ${t(`instructionFiles.source.${view.source}`)}`}
          </Typography>
        </Stack>

        {/* Путь стоит под СВОИМ именем, а не общим списком снизу: одним блоком
            при двух читаемых и одном игнорируемом нельзя было понять, где чей, —
            а человек идёт по этим путям руками, и «AGENTS.md» без каталога
            в проекте с монорепозиторием над ним ничего не говорит. */}
        {view.read.length > 0 && (
          <Stack gap="0">
            <Typography variant="caption" color="subtle" as="p">
              {t('instructionFiles.read', {
                count: view.read.length,
                files: view.read.map((entry) => entry.fileName).join(', '),
              })}
            </Typography>
            {view.read.map((entry) => (
              <Typography
                key={entry.filePath}
                variant="caption"
                color="subtle"
                as="p"
                className={styles.path}
              >
                {entry.filePath}
              </Typography>
            ))}
          </Stack>
        )}

        {view.ignored.length > 0 && (
          <Stack gap="0">
            <Typography variant="caption" color="subtle" as="p">
              {t('instructionFiles.ignored', {
                count: view.ignored.length,
                files: view.ignored.map((entry) => entry.fileName).join(', '),
              })}
            </Typography>
            {view.ignored.map((entry) => (
              <Typography
                key={entry.filePath}
                variant="caption"
                color="subtle"
                as="p"
                className={styles.path}
              >
                {entry.filePath}
              </Typography>
            ))}
          </Stack>
        )}

        {/* Ключ списка — сам код: у заметки нет id, а код внутри одного набора
            не повторяется (сервер собирает набор по одной причине на код). */}
        {view.notes.map((note) => (
          <Typography key={note.code} variant="caption" color="muted" as="p">
            {note.code === 'unrecognized' &&
              t('instructionFiles.note.unrecognized', { value: note.value })}
            {note.code === 'ignored-nearby' &&
              t('instructionFiles.note.ignoredNearby', {
                count: note.files.length,
                files: note.files.join(', '),
              })}
            {note.code === 'managed-only' && t('instructionFiles.note.managedOnly')}
            {note.code === 'legacy-key' && t('instructionFiles.note.legacyKey')}
            {note.code === 'unreadable-settings' && t('instructionFiles.note.unreadableSettings')}
          </Typography>
        ))}

        {view.proposed && (
          <Typography variant="caption" color="muted" as="p">
            {t('instructionFiles.proposed')}
          </Typography>
        )}

        {offerChoice && (
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="caption" color="subtle" id={labelId}>
              {t('instructionFiles.chooseName')}
            </Typography>
            <div
              role="radiogroup"
              aria-labelledby={labelId}
              className={styles.choices}
              onKeyDown={handleChoiceKey}
            >
              {view.choices.map((name) => (
                <button
                  key={name}
                  ref={(node) => {
                    if (node) choiceRefs.current.set(name, node);
                    else choiceRefs.current.delete(name);
                  }}
                  type="button"
                  role="radio"
                  aria-checked={name === chosenName}
                  tabIndex={name === tabStop ? 0 : -1}
                  data-choice={name}
                  className={cn(styles.choice, name === chosenName && styles.chosen)}
                  onClick={() => onChooseName(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

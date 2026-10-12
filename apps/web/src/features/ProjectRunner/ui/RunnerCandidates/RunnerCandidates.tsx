import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { stackLabel } from '../../lib/targetFacts';
import type { RunnerCandidatesProps } from './RunnerCandidates.types';
import styles from './RunnerCandidates.module.scss';

/**
 * Все найденные способы запуска цели.
 *
 * Угадать единственно верный нельзя: у Go-сервиса бывает и `make run`, и
 * `go run ./cmd/api`, у Django — `uv run` и голый `python`. Поэтому панель
 * показывает весь список с тем, по каким файлам что найдено, а выбор — один
 * щелчок, без вписывания команды руками. Выбранная команда остаётся находкой:
 * каталог запуска и то, как стек принимает порт, сервер берёт из неё же.
 *
 * Вариант без нужной программы не прячется: человек видит, что `make run`
 * был бы точнее, и знает, что поставить.
 *
 * Отметка ставится сразу, до ответа сервера, — иначе щелчок полсекунды ничего
 * не менял. Не сохранилось — отметка возвращается на прежнее место.
 */
export function RunnerCandidates({ target, isBusy, onChoose }: RunnerCandidatesProps) {
  const { t } = useTranslation();
  const name = useId();
  const candidates = target.candidates ?? [];
  const hasOverride = Boolean(target.commandOverride?.trim());
  const isCustom = target.stack === 'custom';
  const [picked, setPicked] = useState<string | undefined>();
  // Пришло новое состояние с сервера — правда снова у него.
  useEffect(() => setPicked(undefined), [target.command, target.stack]);
  const current = picked ?? (isCustom ? undefined : target.command);

  const choose = (command: string): void => {
    setPicked(command || undefined);
    void onChoose(command).then((saved) => {
      if (!saved) setPicked(undefined);
    });
  };

  // Один вариант и своей команды нет — выбирать не из чего, хватает строки команды.
  if (candidates.length === 0 || (candidates.length === 1 && !hasOverride)) return null;

  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{t('runner.candidates')}</legend>
      {candidates.map((candidate) => {
        const label = stackLabel(candidate.stack, candidate.framework, t);
        return (
          <label key={candidate.command} className={styles.option}>
            <input
              type="radio"
              name={name}
              className={styles.radio}
              checked={candidate.command === current}
              disabled={isBusy}
              onChange={() => choose(candidate.command)}
            />
            <span className={styles.body}>
              <span className={styles.command}>{candidate.command}</span>
              <Typography variant="caption" color="subtle" as="span">
                {[label, candidate.evidence.join(', ')].filter(Boolean).join(' · ')}
              </Typography>
              {!candidate.available && candidate.tool && (
                <Typography variant="caption" color="warning" as="span">
                  {t('runner.toolMissingShort', { tool: candidate.tool })}
                </Typography>
              )}
            </span>
          </label>
        );
      })}
      {hasOverride && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.reset}
          disabled={isBusy}
          onClick={() => choose('')}
          title={t('runner.autoPickHint')}
        >
          {t('runner.autoPick')}
        </Button>
      )}
    </fieldset>
  );
}

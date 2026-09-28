import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { pathLangSchema, type PathLang } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { Button } from '@shared/ui/button';
import { langAfterKey, otherLang } from '../model/stepDraft';
import type { StepProposalEditorProps } from './StepProposalEditor.types';
import styles from './StepProposalEditor.module.scss';

const LANGS = pathLangSchema.options;

/**
 * Итоговый шаг с вкладками RU | EN. Прогон читает только английскую сторону,
 * человек чаще пишет по-русски — поэтому правка одной стороны помечает вторую
 * устаревшей и предлагает перевести её тем же ассистентом, а не руками.
 */
export function StepProposalEditor({
  proposal,
  lang,
  edited,
  bothEdited,
  isTranslating,
  onLangChange,
  onEdit,
  onTranslate,
  onTranslateFrom,
  onKeepBoth,
}: StepProposalEditorProps) {
  const { t } = useTranslation();
  const refs = useRef(new Map<PathLang, HTMLButtonElement>());
  const panelId = 'step-proposal-panel';
  const langLabel = (side: PathLang): string => t(`groupPath.composer.lang_${side}`);
  const missing = LANGS.find((side) => !proposal.prompt[side].trim());

  // Стрелки ходят по двум вкладкам, Home/End — к краям, как в любом tablist панели.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = langAfterKey(event.key, lang);
    if (!next) return;
    event.preventDefault();
    onLangChange(next);
    refs.current.get(next)?.focus();
  };

  return (
    <Stack gap="var(--spacing-sm)" className={styles.editor}>
      <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
        <Typography variant="body-sm" weight="medium">
          {t('groupPath.composer.proposal')}
        </Typography>
        <div
          role="tablist"
          aria-label={t('groupPath.composer.langTabs')}
          className={styles.tabs}
          onKeyDown={handleKeyDown}
        >
          {LANGS.map((side) => (
            <button
              key={side}
              ref={(node) => {
                if (node) refs.current.set(side, node);
                else refs.current.delete(side);
              }}
              type="button"
              role="tab"
              id={`step-lang-${side}`}
              aria-selected={side === lang}
              aria-controls={panelId}
              tabIndex={side === lang ? 0 : -1}
              className={`${styles.tab} ${side === lang ? styles.tabActive : ''}`}
              onClick={() => onLangChange(side)}
            >
              {langLabel(side)}
            </button>
          ))}
        </div>
      </Stack>

      <div role="tabpanel" id={panelId} aria-labelledby={`step-lang-${lang}`}>
        <Stack gap="var(--spacing-sm)">
          <TextField
            label={t('groupPath.composer.titleLabel')}
            value={proposal.title[lang]}
            onChange={(value) => onEdit('title', lang, value)}
          />
          <TextField
            label={t('groupPath.composer.promptLabel')}
            value={proposal.prompt[lang]}
            onChange={(value) => onEdit('prompt', lang, value)}
            multiline
            rows={5}
          />
          <TextField
            label={t('groupPath.composer.gateLabel')}
            value={proposal.gate?.[lang] ?? ''}
            onChange={(value) => onEdit('gate', lang, value)}
          />
        </Stack>
      </div>

      {bothEdited && (
        <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
          <Typography variant="caption" color="warning">
            {t('groupPath.composer.bothEdited')}
          </Typography>
          {LANGS.map((side) => (
            <Button
              key={side}
              size="sm"
              isLoading={isTranslating}
              onClick={() => onTranslateFrom(side)}
            >
              {t('groupPath.composer.translateFrom', {
                from: langLabel(side),
                to: langLabel(otherLang(side)),
              })}
            </Button>
          ))}
          <Button size="sm" disabled={isTranslating} onClick={onKeepBoth}>
            {t('groupPath.composer.keepBoth')}
          </Button>
        </Stack>
      )}
      {edited && !bothEdited && (
        <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
          <Typography variant="caption" color="warning">
            {t('groupPath.composer.staleSide', {
              edited: langLabel(edited),
              other: langLabel(otherLang(edited)),
            })}
          </Typography>
          <Button size="sm" isLoading={isTranslating} onClick={onTranslate}>
            {t('groupPath.composer.translate', { lang: langLabel(otherLang(edited)) })}
          </Button>
        </Stack>
      )}
      {missing && (
        <Typography variant="caption" color="danger">
          {t('groupPath.composer.missingSide', { lang: langLabel(missing) })}
        </Typography>
      )}
      <Typography variant="caption" color="subtle">
        {t('groupPath.composer.runsEn')}
      </Typography>
    </Stack>
  );
}

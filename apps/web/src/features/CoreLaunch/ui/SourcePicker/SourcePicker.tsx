import { useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { INTAKE_SOURCES_MAX } from '@agentdeck/contracts/core/intake';
import { useSpeechRecognition } from '@shared/hooks/use-speech-recognition';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { readTrackerSnapshot } from '../../api/leadSettingsApi';
import {
  emptyItem,
  ITEMS_AS,
  SOURCE_MODES,
  withSnapshot,
  withTrackerKey,
} from '../../model/launchSource';
import type { ItemsAs, LaunchDraft, SourceDraft, SourceItemDraft } from '../../model/launch.types';
import styles from '../rows.module.scss';

type Update = (fn: (draft: LaunchDraft) => LaunchDraft) => void;

interface SourcePickerProps {
  draft: LaunchDraft;
  onDraft: Update;
  /** Код проблемы источника (`tracker-unread`, `items-empty`, `source`); нет — `undefined`. */
  problem?: string;
}

const P = 'coreLaunch.source';

const withSource = (draft: LaunchDraft, patch: Partial<SourceDraft>): LaunchDraft => ({
  ...draft,
  source: { ...draft.source, ...patch },
});

/**
 * Источник задачи (этап 11, P133): текст (по умолчанию), задача трекера — снимок читает панель,
 * голос — расшифровка ложится в требования, несколько пунктов — `sources[]`. Время снимка
 * пишется при правке, отпечаток — при отправке.
 */
export function SourcePicker({ draft, onDraft, problem }: SourcePickerProps) {
  const { t } = useTranslation();
  const src = draft.source;
  const setMode = (mode: SourceDraft['mode']) =>
    onDraft((d) =>
      withSource(d, {
        mode,
        ...(mode === 'voice' && d.source.voiceAt === null ? { voiceAt: Date.now() } : {}),
        ...(mode === 'items' && d.source.items.length === 0
          ? { items: [emptyItem(Date.now())] }
          : {}),
      }),
    );
  return (
    <Stack gap="var(--spacing-xs)" data-source-picker={src.mode}>
      <SelectField
        label={t(`${P}.label`)}
        hint={t(`${P}.hint`)}
        value={src.mode}
        options={SOURCE_MODES.map((m) => ({ value: m, label: t(`${P}.modes.${m}`) }))}
        onChange={(v) => setMode(v as SourceDraft['mode'])}
      />
      {src.mode === 'tracker' && <TrackerSource draft={draft} onDraft={onDraft} />}
      {src.mode === 'voice' && <VoiceSource onDraft={onDraft} />}
      {src.mode === 'items' && (
        <ItemsSource items={src.items} itemsAs={src.itemsAs} onDraft={onDraft} />
      )}
      {problem && (
        <Typography variant="caption" color="danger" as="p" data-source-problem={problem}>
          {t(`${P}.problems.${problem}`)}
        </Typography>
      )}
    </Stack>
  );
}

function TrackerSource({ draft, onDraft }: { draft: LaunchDraft; onDraft: Update }) {
  const { t } = useTranslation();
  const read = useMutation({ mutationFn: readTrackerSnapshot });
  const { trackerKey, snapshot } = draft.source;
  return (
    <Stack gap="var(--spacing-xs)">
      <div className={styles.inlineField}>
        <TextField
          label={t(`${P}.trackerKey`)}
          hint={t(`${P}.trackerKeyHint`)}
          value={trackerKey}
          onChange={(v) => onDraft((d) => withTrackerKey(d, v))}
          isMono
        />
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!trackerKey.trim()}
            isLoading={read.isPending}
            onClick={() => {
              // Ключ чтения запомнен: ответ, пришедший после смены ключа, черновик отбросит.
              const key = trackerKey.trim();
              read.mutate(key, { onSuccess: (snap) => onDraft((d) => withSnapshot(d, snap, key)) });
            }}
            data-source-tracker-read
          >
            {t(`${P}.read`)}
          </Button>
        </div>
      </div>
      {read.isError && (
        <Typography variant="caption" color="danger" as="p" role="alert" data-source-error>
          {toErrorMessage(read.error)}
        </Typography>
      )}
      {snapshot && (
        <div className={styles.row} data-source-snapshot data-source-digest={snapshot.digest}>
          <Typography variant="body-sm" weight="medium" as="p">
            {t(`${P}.snapshot`, { key: snapshot.key ?? '', title: snapshot.title ?? '' })}
          </Typography>
          <Typography variant="caption" color="muted" as="p">
            {snapshot.acceptance
              ? t(`${P}.snapshotCriteria`, { count: snapshot.acceptance.length })
              : t(`${P}.snapshotNoCriteria`)}
          </Typography>
        </div>
      )}
    </Stack>
  );
}

function VoiceSource({ onDraft }: { onDraft: Update }) {
  const { t, i18n } = useTranslation();
  const speech = useSpeechRecognition(i18n.language === 'en' ? 'en-US' : 'ru-RU');
  const { transcript } = speech;
  useEffect(() => {
    if (transcript)
      onDraft((d) => withSource({ ...d, request: transcript }, { voiceAt: Date.now() }));
  }, [transcript, onDraft]);
  if (!speech.supported) {
    return (
      <Typography variant="caption" color="muted" as="p" data-source-voice="unsupported">
        {t(`${P}.voiceUnsupported`)}
      </Typography>
    );
  }
  return (
    <Stack
      direction="row"
      gap="var(--spacing-xs)"
      align="center"
      wrap
      data-source-voice={speech.state}
    >
      <Button
        size="sm"
        variant={speech.listening ? 'danger' : 'secondary'}
        leftIcon={<Icon name="mic" />}
        onClick={speech.listening ? speech.stop : speech.start}
        isLoading={speech.finalizing}
      >
        {speech.listening ? t(`${P}.voiceStop`) : t(`${P}.voiceStart`)}
      </Button>
      <Typography variant="caption" color="muted" as="span">
        {speech.partial || t(`${P}.voiceHint`)}
      </Typography>
    </Stack>
  );
}

function ItemsSource({
  items,
  itemsAs,
  onDraft,
}: {
  items: SourceItemDraft[];
  itemsAs: ItemsAs;
  onDraft: Update;
}) {
  const { t } = useTranslation();
  const setItem = (index: number, patch: Partial<SourceItemDraft>) =>
    onDraft((d) =>
      withSource(d, {
        items: d.source.items.map((it, i) =>
          i === index ? { ...it, ...patch, at: Date.now() } : it,
        ),
      }),
    );
  return (
    <Stack gap="var(--spacing-xs)" data-source-items={items.length} data-source-items-as={itemsAs}>
      <SelectField
        label={t(`${P}.itemsAs`)}
        hint={t(`${P}.itemsAsHint.${itemsAs}`)}
        value={itemsAs}
        options={ITEMS_AS.map((v) => ({ value: v, label: t(`${P}.itemsAsOptions.${v}`) }))}
        onChange={(v) => onDraft((d) => withSource(d, { itemsAs: v as ItemsAs }))}
      />
      {items.map((item, index) => {
        const n = index + 1;
        return (
          // Пункты без своего id: порядок и есть их личность в форме.
          <div key={index} className={styles.row} data-source-item={n}>
            <Stack gap="var(--spacing-xs)">
              <Stack direction="row" gap="var(--spacing-xs)" align="center" justify="between">
                <Typography variant="body-sm" weight="medium" as="span">
                  {t(`${P}.item`, { n })}
                </Typography>
                {items.length > 1 && (
                  <Button
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="trash" />}
                    aria-label={t(`${P}.removeItem`, { n })}
                    onClick={() =>
                      onDraft((d) =>
                        withSource(d, { items: d.source.items.filter((_, i) => i !== index) }),
                      )
                    }
                  />
                )}
              </Stack>
              <TextField
                label={t(`${P}.itemTitle`, { n })}
                value={item.title}
                onChange={(v) => setItem(index, { title: v })}
              />
              <TextField
                label={t(`${P}.itemBody`, { n })}
                value={item.body}
                onChange={(v) => setItem(index, { body: v })}
                multiline
                rows={3}
              />
            </Stack>
          </div>
        );
      })}
      {items.length < INTAKE_SOURCES_MAX && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="plus" />}
            onClick={() =>
              onDraft((d) => withSource(d, { items: [...d.source.items, emptyItem(Date.now())] }))
            }
          >
            {t(`${P}.addItem`)}
          </Button>
        </div>
      )}
    </Stack>
  );
}

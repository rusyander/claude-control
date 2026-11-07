import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpOffersReply } from '@agentdeck/contracts/core/panel-api';
import { failureOf } from '@entities/CoreTask';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useCoreConfig } from '../../api/launchApi';
import { useMcpOffers, useSavePicks } from '../../api/mcpPicksApi';
import {
  draftChanged,
  draftOf,
  isPicked,
  pickKinds,
  pickRows,
  readOnlyKinds,
  setAllByDefault,
  togglePick,
  type PickRow,
  type PicksDraft,
} from '../../model/mcpPicks';
import { FailureNote } from '../FailureNote/FailureNote';
import styles from './McpPicksCard.module.scss';

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

/**
 * Выбор серверов MCP человека для задач ядра (s10 p9): строки — серверы из конфигов CLI ядра
 * (`GET /v1/mcp-offers`), столбцы — виды шага, которые берут серверы человека; отметка пишется в
 * `config.mcpPicks` одной записью `set-config` (строгий суд, отпечаток). Отказ ядра — дословно.
 */
export function McpPicksCard() {
  const { t } = useTranslation();
  const P = 'coreLaunch.mcpPicks';
  const offers = useMcpOffers();
  const config = useCoreConfig();
  const save = useSavePicks();
  const reply = offers.data;
  const kinds = useMemo(() => (reply ? pickKinds(reply) : []), [reply]);
  const [draft, setDraft] = useState<PicksDraft>({});
  // Черновик заново из настройки, когда меняется записанный выбор MCP (после записи — тоже):
  // правки не копятся поверх чужой записи, а 409 показывает, что настройку изменили. Новое чтение
  // без смены выбора (запись ведения соседней карточкой) несохранённую отметку не трогает.
  const stored = reply ? JSON.stringify(draftOf(config.data, kinds)) : null;
  useEffect(() => {
    if (stored !== null) setDraft(JSON.parse(stored) as PicksDraft);
  }, [stored]);

  let body;
  if (offers.isLoading || config.isLoading) {
    body = null;
  } else if (offers.isError) {
    const status = statusOf(offers.error);
    body = (
      <Typography
        variant="caption"
        color={status === 501 ? 'muted' : 'danger'}
        as="p"
        data-mcp-picks-error={status ?? 'network'}
      >
        {status === 501 ? t(`${P}.notImplemented`) : t(`${P}.loadError`)}
      </Typography>
    );
  } else if (reply) {
    body = (
      <PicksBody
        reply={reply}
        draft={draft}
        canSave={!!config.data}
        saving={save.isPending}
        onDraft={(next) => {
          // Правка после записи: «Сохранено» уже не про то, что на экране.
          if (save.isSuccess) save.reset();
          setDraft(next);
        }}
        onSave={() => {
          if (config.data) save.mutate({ view: config.data, draft, kinds });
        }}
        onReset={() => setDraft(draftOf(config.data, kinds))}
        changed={draftChanged(config.data, draft, kinds)}
      />
    );
  }
  return (
    <Card padding="md" data-launch-section="mcp-picks">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h2">
            {t(`${P}.heading`)}
          </Typography>
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.hint`)}
          </Typography>
        </Stack>
        {body}
        {config.isError && (
          <Typography variant="caption" color="danger" as="p" data-mcp-picks-config-error>
            {t(`${P}.configError`)}
          </Typography>
        )}
        {save.isSuccess && !save.isPending && (
          <Typography variant="caption" color="success" as="p" role="status" data-mcp-picks-saved>
            {t(`${P}.saved`)}
          </Typography>
        )}
        {save.isError && (
          <div data-mcp-picks-refused>
            <FailureNote failure={failureOf(save.error)} />
          </div>
        )}
      </Stack>
    </Card>
  );
}

interface PicksBodyProps {
  reply: McpOffersReply;
  draft: PicksDraft;
  canSave: boolean;
  saving: boolean;
  changed: boolean;
  onDraft: (next: PicksDraft) => void;
  onSave: () => void;
  onReset: () => void;
}

function PicksBody({
  reply,
  draft,
  canSave,
  saving,
  changed,
  onDraft,
  onSave,
  onReset,
}: PicksBodyProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.mcpPicks';
  const kinds = pickKinds(reply);
  const rows = pickRows(reply, draft);
  const kindLabel = (kind: string) => t(`${P}.kind.${kind}`, { defaultValue: kind });
  const readOnly = readOnlyKinds(reply);
  const unread = reply.clis.flatMap((c) => c.unread.map((u) => ({ cli: c.cli, ...u })));

  return (
    <Stack gap="var(--spacing-sm)">
      {rows.length === 0 ? (
        <Typography variant="caption" color="muted" as="p" data-mcp-picks-empty>
          {t(`${P}.empty`)}
        </Typography>
      ) : (
        <div
          className={styles.scroll}
          role="region"
          aria-label={t(`${P}.heading`)}
          // Широкая таблица прокручивается вбок: область доступна с клавиатуры.
          tabIndex={0}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.serverCol}>
                  {t(`${P}.server`)}
                </th>
                {kinds.map((k) => (
                  <th scope="col" key={k.kind} data-mcp-kind={k.kind}>
                    <Stack gap="var(--spacing-3xs)" align="center">
                      <span>{kindLabel(k.kind)}</span>
                      {k.allByDefault && (
                        <label className={styles.defaultToggle} title={t(`${P}.allByDefaultHint`)}>
                          <input
                            type="checkbox"
                            checked={draft[k.kind] === null}
                            disabled={saving}
                            onChange={(e) =>
                              onDraft(setAllByDefault(draft, k.kind, e.target.checked, rows))
                            }
                            data-mcp-all-default={k.kind}
                          />
                          <span>{t(`${P}.allByDefault`)}</span>
                        </label>
                      )}
                    </Stack>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-mcp-row={row.id} data-mcp-unknown={row.unknown || undefined}>
                  <th scope="row" className={styles.serverCol}>
                    <ServerCell row={row} />
                  </th>
                  {kinds.map((k) => (
                    <td key={k.kind} className={styles.cell}>
                      <input
                        type="checkbox"
                        aria-label={t(`${P}.cell`, { server: row.id, kind: kindLabel(k.kind) })}
                        checked={isPicked(draft, k.kind, row)}
                        // Непереносимый сервер выбрать нельзя; уже выбранный неизвестный — снять можно.
                        disabled={saving || (!row.offered && !isPicked(draft, k.kind, row))}
                        onChange={() => onDraft(togglePick(draft, k.kind, row.id, rows))}
                        data-mcp-pick={`${k.kind}:${row.id}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Stack gap="var(--spacing-3xs)">
        {readOnly.length > 0 && (
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.readOnly`, { kinds: readOnly.map(kindLabel).join(', ') })}
          </Typography>
        )}
        {reply.noReader.length > 0 && (
          <Typography variant="caption" color="muted" as="p" data-mcp-no-reader>
            {t(`${P}.noReader`, { clis: reply.noReader.join(', ') })}
          </Typography>
        )}
        {unread.map((u) => (
          <Typography key={`${u.cli}:${u.file}`} variant="caption" color="warning" as="p">
            {`${u.cli}: ${t(`${P}.unread`, { file: u.file, reason: u.reason })}`}
          </Typography>
        ))}
        <Typography variant="caption" color="muted" as="p">
          {t(`${P}.project`)}
        </Typography>
      </Stack>
      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        <Button
          size="sm"
          variant="secondary"
          onClick={onSave}
          disabled={!canSave || !changed}
          isLoading={saving}
          data-mcp-picks-save
        >
          {t(`${P}.save`)}
        </Button>
        {changed && (
          <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>
            {t(`${P}.reset`)}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

function ServerCell({ row }: { row: PickRow }) {
  const { t } = useTranslation();
  const P = 'coreLaunch.mcpPicks';
  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <span className={styles.mono}>{row.id}</span>
        {row.unknown && (
          <Badge tone="danger" withDot>
            {t(`${P}.unknown`)}
          </Badge>
        )}
      </Stack>
      {row.unknown ? (
        <Typography variant="caption" color="muted" as="span">
          {t(`${P}.unknownHint`)}
        </Typography>
      ) : (
        row.offers.map((o) => (
          <Typography key={o.cli} variant="caption" color="muted" as="span">
            {`${o.cli}: ${t(`${P}.scope.${o.scope}`)}, ${
              o.transport
                ? t(`${P}.transport.${o.transport}`)
                : t(`${P}.notCarried`, { reason: o.skipped ?? '' })
            }`}
          </Typography>
        ))
      )}
    </Stack>
  );
}

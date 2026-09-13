import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ourLayerIds, platformThinkingModes } from '@agentdeck/contracts';
import { platformRunConsumers } from '@agentdeck/contracts/platform-consumers';
import type {
  OurLayerId,
  Platform,
  PlatformRunLayers,
  PlatformRuleConflict,
  PlatformRuleRow,
  PlatformThinkingMode,
} from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { CodeText, Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Toggle } from '@shared/ui/toggle';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { useSavePlatform } from '@entities/Platform';
import {
  blockingConflict,
  conflictTone,
  layerOn,
  managedRules,
  observedRules,
  ourRules,
  parseToolNames,
  platformRules,
  withOurRule,
  withRule,
} from './lib/rulesView';

interface RulesCardProps {
  platform: Platform;
  /**
   * Правила из манифеста драйвера: чем распоряжаемся и что только видно.
   * Необязательны намеренно — ответ без них приносит рассинхрон версий, и
   * падение здесь унесло бы с экрана весь раздел, а не одну карточку.
   */
  rules?: PlatformRuleRow[];
  /** Ячейки матрицы: где правило контура спорит с нашим. */
  conflicts?: PlatformRuleConflict[];
  /**
   * Что из нашего унесёт прогон через этот контур (Т8) — СЧИТАЕТ СЕРВЕР. Экран
   * показывает готовые флаги, а не собирает их заново: разошедшись, вторая
   * сборка обещала бы снятый слой при полном запуске. Необязательны по той же
   * причине, что и правила выше: ответ старого сервера их не приносит.
   */
  layers?: PlatformRunLayers;
}

/**
 * Правила контура и матрица конфликтов (Т7).
 *
 * Два списка вместо одного намеренно. Сверху то, чем панель РАСПОРЯЖАЕТСЯ:
 * поля запроса, которые контур принимает, — их видно как настройки. Снизу то,
 * что контур делает с запросом сам и чего отсюда не отменить: гардрейлы,
 * подмена данных, знания компании, сжатие истории. Человек, не нашедший
 * галочки, должен прочитать «включает владелец контура», а не решить, что
 * панель сломалась.
 *
 * Матрица конфликтов внизу — ответ на вопрос «а не спорит ли это с нашим». Из
 * четырёх ячеек красная ровно одна: два набора инструментов на один ход. Три
 * остальные — не выбор из двух, а порядок слоёв, предупреждение и факт; и
 * сказано это прямо, потому что человек, увидевший слово «конфликт», по
 * привычке выключает одну сторону.
 */
export function RulesCard({ platform, rules = [], conflicts = [], layers }: RulesCardProps) {
  const { t } = useTranslation();
  const save = useSavePlatform();
  const current = platformRules(platform);
  const stored = current.platformTools.join(', ');
  const [tools, setTools] = useState(stored);
  const [preset, setPreset] = useState(current.generationPreset);

  // Поля ввода следуют за ответом сервера: тот же контур правят с телефона, из
  // другой вкладки и мастером, и кнопка «Сохранить» предлагала бы записать
  // старое значение поверх нового. Состояние заводится заново, когда приехало
  // ДРУГОЕ сохранённое значение, — недописанная строка человека этим не
  // стирается (ревью Т7, m5).
  const [seen, setSeen] = useState({ tools: stored, preset: current.generationPreset });
  if (seen.tools !== stored || seen.preset !== current.generationPreset) {
    setSeen({ tools: stored, preset: current.generationPreset });
    if (seen.tools !== stored) setTools(stored);
    if (seen.preset !== current.generationPreset) setPreset(current.generationPreset);
  }

  const managed = managedRules(rules);
  const observed = observedRules(rules);
  const blocking = blockingConflict(conflicts);
  const update = (next: Platform): void => {
    save.mutate({ platform: next });
  };

  /**
   * Две стороны взаимного исключения, и каждая запирает ТОЛЬКО добавление своей.
   *
   * Набор контура непуст — прослойку не включить, пока он не убран; прослойка
   * включена — набор контура не ДОБАВИТЬ, но уже записанный (его приносит
   * разворот чужого архива) правится и убирается: запертое наглухо поле было бы
   * тупиком, из которого человек выходит только удалением контура (ревью Т7).
   */
  const hasPlatformTools = current.platformTools.length > 0;
  const toolsLocked = platform.toolShim && !hasPlatformTools;
  const shimLocked = !platform.toolShim && hasPlatformTools;

  /**
   * Наши слои (Т8). Общий выключатель сильнее частных галочек — ровно как на
   * сервере (`domains/platform/layers.ts`), и частная показывается снятой, пока
   * снят общий: показать её включённой значило бы обещать слой, которого в
   * прогоне не будет.
   */
  const ours = ourRules(platform);

  /**
   * Достаются ли эти флаги хоть кому-нибудь. Слои снимает ЗАПУСК Claude — чат,
   * группы разделения, агент тестов; у контура, отмеченного только терминалом,
   * ассистентом или чужим CLI, карточка перечисляла флаги, которых не получит
   * ни один прогон (ревью Т8): терминал правит файлы, ассистент ходит профилем
   * эндпоинта, а чужому CLI слоёв не выдают вовсе.
   */
  const claudeRuns = (platform.consumers ?? []).some((id) =>
    (platformRunConsumers as readonly string[]).includes(id),
  );

  const layerRow = (id: OurLayerId) => (
    <Stack key={id} direction="row" align="center" gap="var(--spacing-xs)" wrap>
      <Toggle
        checked={layerOn(ours, id)}
        onCheckedChange={(checked) => update(withOurRule(platform, id, checked))}
        aria-label={t(`platform.layerTitle.${id}`)}
        disabled={!ours.enabled}
      />
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Typography variant="body-sm" as="span">
            {t(`platform.layerTitle.${id}`)}
          </Typography>
          {/* Подпись стоит у той галочки, которой касается: правила, хуки и
              права снимаются вместе, потому что у CLI это один источник. */}
          {id === 'settings' && <CompromiseMark id="rules-partial" />}
        </Stack>
        <Typography
          variant="caption"
          color="muted"
          as="span"
          style={{ maxWidth: 'var(--text-measure)' }}
        >
          <CodeText text={t(`platform.layerText.${id}`)} />
        </Typography>
      </Stack>
    </Stack>
  );

  /** Изменения полей ввода применяются кнопкой: сохранять на каждую букву незачем. */
  const toolsChanged = parseToolNames(tools).join(', ') !== stored;
  const presetChanged = preset.trim() !== current.generationPreset;

  const field = (row: PlatformRuleRow) => {
    if (row.field === 'platformTools') {
      return (
        <Stack key={row.id} gap="var(--spacing-3xs)">
          <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
            <TextField
              label={row.title}
              value={tools}
              onChange={setTools}
              placeholder={t('platform.rulesToolsPlaceholder')}
              // Причина запрета живёт в подсказке поля, а не отдельной строкой
              // под ним: запертое поле выброшено из обхода табом, и человек с
              // клавиатуры до объяснения не доходил вовсе (ревью Т7, m3).
              hint={toolsLocked ? t('platform.rulesToolsBlocked') : row.detail}
              disabled={toolsLocked}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!toolsChanged || toolsLocked}
              onClick={() => update(withRule(platform, 'platformTools', parseToolNames(tools)))}
            >
              {t('platform.rulesApply')}
            </Button>
          </Stack>
        </Stack>
      );
    }

    if (row.field === 'toolMode') {
      // Остаётся доступным и при пустом списке инструментов, хотя тогда никуда
      // не отправляется (об этом — подсказка ниже): режим выбирают ДО того, как
      // впишут имена, и запертый селект заставлял бы возвращаться сюда вторым
      // заходом. Ревью Т7 (m7) предлагало запереть — решено оставить.
      return (
        <SelectField
          key={row.id}
          label={row.title}
          value={current.toolMode}
          onChange={(value) =>
            update(
              withRule(platform, 'toolMode', value as Platform['rules']['platform']['toolMode']),
            )
          }
          options={(row.options ?? []).map((option) => ({
            value: option,
            label: t(`platform.rulesToolMode.${option}`, { defaultValue: option }),
          }))}
          hint={current.platformTools.length === 0 ? t('platform.rulesModeIdle') : row.detail}
        />
      );
    }

    if (row.field === 'generationPreset') {
      return (
        <Stack key={row.id} direction="row" align="end" gap="var(--spacing-xs)" wrap>
          <TextField
            label={row.title}
            value={preset}
            onChange={setPreset}
            placeholder={t('platform.rulesPresetPlaceholder')}
            hint={row.detail}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!presetChanged}
            onClick={() => update(withRule(platform, 'generationPreset', preset.trim()))}
          >
            {t('platform.rulesApply')}
          </Button>
        </Stack>
      );
    }

    // Три состояния, а не выключатель: «не отправлять» и «выключить» у
    // reasoning-модели различаются — думать по умолчанию она может сама.
    if (row.field === 'enableThinking') {
      return (
        <SelectField
          key={row.id}
          label={row.title}
          value={current.enableThinking}
          onChange={(value) =>
            update(withRule(platform, 'enableThinking', value as PlatformThinkingMode))
          }
          options={platformThinkingModes.map((mode) => ({
            value: mode,
            label: t(`platform.rulesThinkingMode.${mode}`),
          }))}
          hint={row.detail}
        />
      );
    }

    // Правило, объявленное задаваемым, но панелью ещё не нарисованное. Раньше
    // сюда падала ветка по умолчанию и рисовала ЧУЖОЙ тумблер: новое булево
    // правило манифеста показывало бы значение `enableThinking` и писало бы его
    // же (ревью Т7, m8). Честнее показать значение и сказать, что ручки нет.
    return (
      <Stack key={row.id} gap="var(--spacing-3xs)">
        <Typography variant="body-sm" as="span">
          {row.title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t('platform.rulesUnsupported', { value: row.value || '—' })}
        </Typography>
      </Stack>
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h2">
            {t('platform.rulesTitle', { title: platform.title })}
          </Typography>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.rulesText')}
          </Typography>
        </Stack>

        {/* Драйвер, не объявивший о себе ничего (любой совместимый шлюз), даёт
            пустой список — и это «неизвестно», а не «ничего не делает». */}
        {rules.length === 0 && (
          <Typography variant="body-sm" color="muted">
            {t('platform.rulesEmpty')}
          </Typography>
        )}

        {managed.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.rulesManaged')}
            </Typography>
            {managed.map((row) => field(row))}
          </Stack>
        )}

        {/* Наша сторона взаимного исключения — здесь же, а не «где-то на
            карточке контура»: до ревью Т7 подпись отправляла человека к
            выключателю, которого не было НИГДЕ, и два управляемых правила из
            четырёх нельзя было задать вовсе. Т8 добавил сюда наши слои. */}
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('platform.rulesOurs')}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Toggle
              checked={platform.toolShim}
              onCheckedChange={(checked) => update({ ...platform, toolShim: checked })}
              aria-label={t('platform.rulesShim')}
              disabled={shimLocked}
            />
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body-sm" as="span">
                {t('platform.rulesShim')}
              </Typography>
              <Typography
                variant="caption"
                color="muted"
                as="span"
                style={{ maxWidth: 'var(--text-measure)' }}
              >
                {shimLocked ? t('platform.rulesShimBlocked') : t('platform.rulesShimText')}
              </Typography>
            </Stack>
          </Stack>

          {/* Наши слои (Т8): что из `~/.claude` поедет в прогон через ЭТОТ
              контур. Общий выключатель первым — им человек снимает всё разом,
              не разбираясь в четырёх галочках. */}
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.layersTitle')}
            </Typography>
            <Typography variant="caption" color="muted" style={{ maxWidth: 'var(--text-measure)' }}>
              <CodeText text={t('platform.layersText')} />
            </Typography>

            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Toggle
                checked={ours.enabled}
                onCheckedChange={(checked) => update(withOurRule(platform, 'enabled', checked))}
                aria-label={t('platform.layersAll')}
              />
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" as="span">
                  {t('platform.layersAll')}
                </Typography>
                <Typography
                  variant="caption"
                  color="muted"
                  as="span"
                  style={{ maxWidth: 'var(--text-measure)' }}
                >
                  {/* Причина запертых галочек стоит НАД ними: запертый тумблер
                      выброшен из обхода табом, и объяснение под ним человек с
                      клавиатуры не прочитал бы вовсе (урок ревью Т7, m3). */}
                  {ours.enabled ? t('platform.layersAllText') : t('platform.layersAllOff')}
                </Typography>
              </Stack>
            </Stack>

            {ourLayerIds.map((id) => layerRow(id))}

            {/* Флаги показываются настоящие: «личные правила сняты» без того,
                чем именно, — это просьба верить на слово. Считает их сервер. */}
            {layers && (
              <Typography
                variant="caption"
                color="muted"
                style={{ maxWidth: 'var(--text-measure)' }}
              >
                {layers.args.length > 0
                  ? t('platform.layersFlags', { args: layers.args.join(' ') })
                  : t('platform.layersFlagsNone')}
                {!layers.systemPrompt && ` ${t('platform.layersPromptOff')}`}
                {!claudeRuns && ` ${t('platform.layersNoRun')}`}
              </Typography>
            )}

            {/* Три соседние настройки, которых здесь НЕТ и не будет: человек,
                не нашедший галочки, должен прочитать почему, а не решить, что
                панель потеряла слой. */}
            <Typography variant="caption" color="muted" style={{ maxWidth: 'var(--text-measure)' }}>
              <CodeText text={t('platform.layersNotes')} />
            </Typography>
          </Stack>
        </Stack>

        {/* Отказ сервера читается вслух: сохранение, ушедшее в никуда, человек
            замечает по вернувшемуся старому значению и винит панель. */}
        {save.isError && (
          <Typography variant="body-sm" color="danger" role="alert">
            {save.error instanceof Error ? save.error.message : t('platform.rulesSaveFailed')}
          </Typography>
        )}

        {observed.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.rulesObserved')}
            </Typography>
            {observed.map((row) => (
              <Stack key={row.id} gap="var(--spacing-3xs)">
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                  <Typography variant="body-sm" as="span">
                    {row.title}
                  </Typography>
                  <Badge tone="neutral">{row.where}</Badge>
                </Stack>
                <Typography variant="caption" color="muted" as="span">
                  {row.detail}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}

        {conflicts.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.rulesConflicts')}
            </Typography>
            {conflicts.map((conflict) => (
              <Stack key={conflict.id} gap="var(--spacing-3xs)">
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                  <Badge tone={conflictTone(conflict.level)}>
                    {t(`platform.rulesLevel.${conflict.level}`)}
                  </Badge>
                  <Typography variant="body-sm" as="span">
                    {conflict.title}
                  </Typography>
                  {/* «Включены обе» говорится только там, где панель видит обе
                      половины; про гардрейлы и подмену данных она знает лишь
                      свою (ревью Т7, M3). */}
                  {(conflict.active || conflict.oursOnly) && (
                    <Typography variant="caption" color="muted" as="span">
                      {conflict.active
                        ? t('platform.rulesConflictActive')
                        : t('platform.rulesConflictOurs')}
                    </Typography>
                  )}
                </Stack>
                <Typography
                  variant="caption"
                  color="muted"
                  as="span"
                  style={{ maxWidth: 'var(--text-measure)' }}
                >
                  {conflict.detail}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}

        {/* Состояние, в которое обычной дорогой не попасть: его приносит разворот
            чужого архива. Сказать о нём надо здесь — прогон до тех пор идёт с
            инструментами контура, и прослойка молчит, — и назвать ОБА выхода:
            отказ без выхода это не «человек решает сам», а «человек не решает
            ничего» (ревью Т7, B3). */}
        {blocking && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" color="danger" role="alert">
              {t('platform.rulesBlocked', { detail: blocking.detail })}
            </Typography>
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => update({ ...platform, toolShim: false })}
              >
                {t('platform.rulesFixShim')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setTools('');
                  update(withRule(platform, 'platformTools', []));
                }}
              >
                {t('platform.rulesFixTools')}
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

import type {
  ChatBranchStatus,
  ChatCatalogRead,
  ChatChangesRead,
  ChatFailure,
  ChatFamily,
  ChatFlightMode,
  ChatPlanState,
  ChatThread,
  CliSettings,
  TaskSummary,
} from '@crewkite/contracts';
import { Box, Text } from 'ink';
import { createElement as h, type ReactNode } from 'react';
import { modelGroups } from '../../../desktop/src/renderer/thread/model-groups.ts';
import { outputLimitLine } from '../../../desktop/src/renderer/thread/output-limit.ts';
import { planCard } from '../../../desktop/src/renderer/thread/plan-card.ts';
import type { ThreadItem } from '../../../desktop/src/renderer/thread/thread-state.ts';
import {
  type Block,
  roleLabels,
  runLabel,
  type ToolBlock,
  type TurnView,
  viewBlocks,
} from '../../../desktop/src/renderer/thread/turn-fold.ts';
import { gaugeAge, railFamilies } from '../../../desktop/src/renderer/usage-presentation.ts';
import { type SlashCommand, slashCommands } from '../chat/composer-shared.ts';
import { type Art, pickWordmark, spinnerFrames } from './brand.ts';
import type { Composer } from './composer-state.ts';
import { defaultKeys, keyLabel, keysFor } from './keys.ts';
import { Markdown } from './markdown.ts';
import { familyMarks, familyNames, gaugeBar, gaugeHex, type Palette, safeText } from './theme.ts';

// Every view of the interactive CLI as a pure function of its data. The app holds the state and
// the keys; these only draw, so a test renders each one from a fixture.

export type Animation = 'full' | 'reduced' | 'off';

export function ArtView({ art, colors }: { art: Art; colors: Palette }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...art.map((row, index) =>
      h(
        Text,
        { key: index },
        ...row.map((cell, at) =>
          h(
            Text,
            {
              key: at,
              color: cell.panel ? colors.panel[cell.panel] : cell.word ? colors.text : colors.muted,
              bold: cell.word,
            },
            cell.text,
          ),
        ),
      ),
    ),
  );
}

export const Wordmark = ({ columns, colors }: { columns: number; colors: Palette }) =>
  ArtView({ art: pickWordmark(columns), colors });

export function FamilyMark({ family, colors }: { family: ChatFamily; colors: Palette }) {
  return h(Text, { color: colors.family[family], bold: true }, familyMarks[family]);
}

/** The kite spinner while a reply streams. Reduced motion and off keep the kite still. */
export function Spinner({
  frame,
  animation,
  colors,
  label,
}: {
  frame: number;
  animation: Animation;
  colors: Palette;
  label: string;
}) {
  const still = animation !== 'full';
  const current = spinnerFrames[still ? 0 : frame % spinnerFrames.length];
  return h(
    Text,
    null,
    h(Text, { color: colors.panel[current.panel] }, '◆'),
    h(Text, { color: colors.muted }, still ? '  ' : current.tail),
    ' ',
    h(Text, { color: colors.muted }, label),
  );
}

/** One row per family with its allowance gauge, as the desktop rail shows it. */
export function UsageLine({
  catalog,
  nowMs,
  colors,
  only,
}: {
  catalog: ChatCatalogRead | null;
  nowMs: number;
  colors: Palette;
  only?: ChatFamily;
}) {
  const rows = railFamilies(catalog, nowMs).filter((row) => !only || row.family === only);
  if (rows.length === 0)
    return only ? null : h(Text, { color: colors.muted }, 'Reading providers.');
  return h(
    Box,
    { flexWrap: 'wrap', columnGap: 3 },
    ...rows.map((row) => {
      const entry = catalog?.families.find((value) => value.family === row.family);
      const { dotted } = gaugeAge(entry?.readAt ?? null, nowMs);
      const bar = row.bars[0] ?? null;
      const percent = bar?.percent ?? null;
      const cells = gaugeBar(percent, dotted, 8);
      return h(
        Box,
        { key: row.family, gap: 1 },
        FamilyMark({ family: row.family, colors }),
        row.unlimited
          ? h(Text, { color: colors.muted }, 'on this computer')
          : row.setUp
            ? h(Text, { color: colors.muted }, 'set up')
            : row.needsConnect
              ? h(Text, { color: colors.muted }, 'connect')
              : h(
                  Text,
                  null,
                  h(
                    Text,
                    { color: percent === null || !colors.color ? colors.muted : gaugeHex(percent) },
                    cells.filled,
                  ),
                  h(Text, { color: colors.border }, cells.empty),
                  ' ',
                  h(Text, { color: colors.muted }, row.bars.map((value) => value.text).join(' · ')),
                ),
      );
    }),
  );
}

const activityMark: Record<TaskSummary['chatActivity'], string> = {
  idle: ' ',
  running: '●',
  waiting: '?',
  failed: '!',
};

export function ThreadListView({
  threads,
  selected,
  colors,
  complete,
}: {
  threads: readonly TaskSummary[];
  selected: number;
  colors: Palette;
  complete: boolean;
}) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, 'Threads'),
    threads.length === 0
      ? h(Text, { color: colors.muted }, 'No threads yet. Press N to start one.')
      : null,
    ...threads.map((task, index) =>
      h(
        Text,
        { key: task.id, inverse: index === selected },
        h(
          Text,
          {
            color:
              task.chatActivity === 'failed'
                ? colors.red
                : task.chatActivity === 'waiting'
                  ? colors.amber
                  : colors.green,
          },
          activityMark[task.chatActivity],
        ),
        ' ',
        safeText(task.title),
      ),
    ),
    complete ? null : h(Text, { color: colors.amber }, 'Some threads could not be read.'),
    h(Text, { color: colors.muted }, 'Enter opens. N starts a new thread. Esc goes back.'),
  );
}

const toolIcon = (tool: ToolBlock) =>
  tool.status === 'running'
    ? '…'
    : tool.status === 'ok'
      ? '✓'
      : tool.status === 'denied'
        ? '⊘'
        : tool.status === 'stopped'
          ? '■'
          : '✗';

function ToolCard({ tool, colors }: { tool: ToolBlock; colors: Palette }) {
  const diff = tool.diff
    ? h(
        Text,
        null,
        ' ',
        h(Text, { color: colors.green }, `+${tool.diff.additions}`),
        ' ',
        h(Text, { color: colors.red }, `-${tool.diff.deletions}`),
      )
    : null;
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      null,
      h(Text, { color: tool.status === 'error' ? colors.red : colors.muted }, `${toolIcon(tool)} `),
      safeText(tool.title),
      diff,
    ),
    tool.summary ? h(Text, { color: colors.muted }, `  ${safeText(tool.summary)}`) : null,
  );
}

export function PermissionPrompt({
  block,
  policy,
  colors,
  focused = false,
}: {
  block: Extract<Block, { kind: 'permission' }>;
  policy: ChatThread['permissionPolicy'] | null;
  colors: Palette;
  /** Digits answer only while the prompt has focus; Tab moves it there from the message box. */
  focused?: boolean;
}) {
  const answered = block.choice !== null;
  const chosen = block.options.find((option) => option.id === block.choice);
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: focused ? 'double' : 'round',
      borderColor: answered ? colors.border : colors.amber,
      paddingX: 1,
    },
    h(Text, { bold: true }, safeText(block.question)),
    block.detail ? h(Text, { color: colors.muted }, safeText(block.detail)) : null,
    answered
      ? h(
          Text,
          { color: colors.muted },
          `Answered: ${safeText(chosen?.label ?? block.choice ?? '')}`,
        )
      : h(
          Text,
          null,
          ...block.options.map((option, index) =>
            h(
              Text,
              { key: option.id, color: option.kind === 'deny' ? colors.red : colors.accent },
              `${index > 0 ? '   ' : ''}[${index + 1}] ${safeText(option.label)}`,
            ),
          ),
        ),
    answered || !policy
      ? null
      : h(
          Text,
          { color: colors.muted },
          focused
            ? `Thread policy: ${policyLabels[policy]}. Press ${block.options.length === 2 ? '1 or 2' : `1 to ${block.options.length}`} to answer, Tab to go back.`
            : `Thread policy: ${policyLabels[policy]}. Press Tab to answer.`,
        ),
  );
}

export const policyLabels: Record<ChatThread['permissionPolicy'], string> = {
  ask: 'Ask each time',
  'allow-edits': 'Allow edits',
  'allow-all': 'Allow all',
};

function TurnHeader({
  turn,
  colors,
  frame,
  animation,
}: {
  turn: TurnView;
  colors: Palette;
  frame: number;
  animation: Animation;
}) {
  const identity = turn.identity;
  const role = identity ? roleLabels[identity.role] : null;
  return h(
    Box,
    { gap: 1 },
    identity ? FamilyMark({ family: identity.family, colors }) : h(Text, null, '◆'),
    h(Text, { color: colors.muted }, identity ? safeText(identity.model) : 'Starting'),
    role ? h(Text, { color: colors.accent }, `[${role}]`) : null,
    turn.ended
      ? turn.status === 'stopped'
        ? h(Text, { color: colors.muted }, 'Stopped')
        : null
      : Spinner({
          frame,
          animation,
          colors,
          label: turn.status === 'waiting-permission' ? 'Waiting for you' : 'Working',
        }),
  );
}

export function TurnCard({
  turn,
  colors,
  width,
  frame,
  animation,
  policy,
  showThinking,
  promptFocus = false,
}: {
  promptFocus?: boolean;
  turn: TurnView;
  colors: Palette;
  width: number;
  frame: number;
  animation: Animation;
  policy: ChatThread['permissionPolicy'] | null;
  showThinking: boolean;
}) {
  const laid = viewBlocks(turn.blocks, turn.ended);
  const blockNode = (item: ReturnType<typeof viewBlocks>[number]): ReactNode => {
    if (item.kind === 'run')
      return h(Text, { key: item.id, color: colors.muted }, `✓ ${runLabel(item)}`);
    switch (item.kind) {
      case 'text':
        return h(Markdown, { key: item.id, text: item.text, colors, width: width - 2 });
      case 'thinking': {
        const lines = item.text.trim().split('\n');
        const live = !item.done && !turn.ended;
        return h(
          Box,
          {
            key: item.id,
            flexDirection: 'column',
            borderStyle: 'round',
            borderColor: colors.border,
            paddingX: 1,
          },
          h(Text, { color: colors.muted, italic: true }, live ? 'Thinking' : 'Thought'),
          showThinking
            ? h(Text, { color: colors.muted }, safeText(item.text.trim()))
            : h(Text, { color: colors.muted, wrap: 'truncate-end' }, safeText(lines.at(-1) ?? '')),
        );
      }
      case 'tool':
        return h(ToolCard, { key: item.id, tool: item, colors });
      case 'permission':
        return h(PermissionPrompt, {
          key: item.id,
          block: item,
          policy: turn.ended ? null : policy,
          colors,
          focused: promptFocus && !turn.ended && item.choice === null,
        });
      case 'notice':
        return item.trace
          ? null
          : h(
              Text,
              { key: item.id, color: item.level === 'warning' ? colors.amber : colors.muted },
              safeText(item.message),
            );
      case 'compacted':
        return h(
          Text,
          { key: item.id, color: colors.muted },
          `Earlier turns summarized to fit the context (${item.coveredTurns} turns).`,
        );
    }
    return null;
  };
  return h(
    Box,
    { flexDirection: 'column' },
    TurnHeader({ turn, colors, frame, animation }),
    h(
      Box,
      { flexDirection: 'column', paddingLeft: 2, gap: 0 },
      ...laid.map(blockNode),
      turn.outputLimit ? h(Text, { color: colors.amber }, outputLimitLine(turn.outputLimit)) : null,
    ),
  );
}

export type TryWith = { family: ChatFamily; label: string };

export function FailureLine({
  failure,
  tryWith,
  colors,
}: {
  failure: ChatFailure;
  tryWith: readonly TryWith[];
  colors: Palette;
}) {
  return h(
    Box,
    { flexDirection: 'column', paddingLeft: 2 },
    h(Text, { color: colors.red }, safeText(failure.message)),
    failure.providerMessage
      ? h(Text, { color: colors.muted }, safeText(failure.providerMessage))
      : null,
    h(Text, null, safeText(failure.nextAction)),
    h(
      Text,
      { color: colors.muted },
      [
        'Alt+R Retry',
        ...tryWith.map(
          (choice, index) => `Alt+${index + 1} Try with ${familyNames[choice.family]}`,
        ),
      ].join('   '),
    ),
  );
}

export function UserMessage({
  text,
  files,
  pending,
  colors,
}: {
  text: string;
  files: readonly { name: string }[];
  pending: boolean;
  colors: Palette;
}) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { color: pending ? colors.muted : colors.text },
      h(Text, { color: colors.accent, bold: true }, '› '),
      safeText(text),
    ),
    files.length
      ? h(
          Text,
          { color: colors.muted },
          `  ${files.map((file) => `⧉ ${safeText(file.name)}`).join('  ')}`,
        )
      : null,
  );
}

export function QueuedList({ thread, colors }: { thread: ChatThread; colors: Palette }) {
  if (thread.queued.length === 0) return null;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: colors.muted }, `Queued (${thread.queued.length})`),
    ...thread.queued.map((message, index) =>
      h(
        Text,
        { key: message.id, color: colors.muted, wrap: 'truncate-end' },
        `${index + 1}. ${safeText(message.text.split('\n')[0])}`,
      ),
    ),
    h(Text, { color: colors.muted }, 'Alt+S sends the first one now. Alt+X takes it back.'),
  );
}

export function PlanCardView({
  plan,
  flight,
  colors,
}: {
  plan: ChatPlanState;
  flight: ChatFlightMode;
  colors: Palette;
}) {
  const card = planCard(plan, flight);
  const statusColor = (status: ChatPlanState['slices'][number]['status']) =>
    status === 'done'
      ? colors.green
      : status === 'failed'
        ? colors.red
        : status === 'running'
          ? colors.accent
          : colors.muted;
  const actions = [
    card.runPlan ? 'R Run plan' : null,
    card.cancel ? 'C Cancel' : null,
    card.stop ? 'S Stop' : null,
    card.rows.some((row) => row.canRun) ? '1-8 Run one slice' : null,
  ].filter(Boolean);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: colors.border, paddingX: 1 },
    h(Text, { bold: true }, `Plan: ${safeText(plan.goal.split('\n')[0])}`),
    h(Text, { color: colors.muted }, card.summary),
    ...card.rows.map((row) =>
      h(
        Box,
        { key: row.slice.id, flexDirection: 'column' },
        h(
          Text,
          null,
          `${row.slice.id}. `,
          h(Text, { color: statusColor(row.slice.status) }, row.statusLabel.padEnd(8)),
          ' ',
          safeText(row.slice.title),
          h(
            Text,
            { color: colors.muted },
            ` (${row.slice.difficulty}${row.slice.readOnly ? ', read only' : ''})`,
          ),
        ),
        row.slice.assignment
          ? h(
              Text,
              { color: colors.muted },
              `   ${familyNames[row.slice.assignment.family]} ${safeText(row.slice.assignment.model)}: ${safeText(row.slice.assignment.reason)}`,
            )
          : null,
        row.waitsOn ? h(Text, { color: colors.muted }, `   ${row.waitsOn}`) : null,
        row.picker
          ? h(
              Text,
              { color: colors.muted },
              `   Candidates: ${row.picker.map((choice) => `${familyNames[choice.family]} ${safeText(choice.model)} (${safeText(choice.reason)})`).join(', ')}`,
            )
          : null,
      ),
    ),
    actions.length ? h(Text, { color: colors.muted }, actions.join('   ')) : null,
  );
}

const flightLabels: Record<ChatFlightMode, string> = {
  manual: 'Manual',
  balanced: 'Balanced',
  glide: 'Glide',
};
export const handoffLabels: Record<ChatThread['handoffMode'], string> = {
  'most-left': 'Most allowance left',
  'resets-first': 'Resets soonest',
  'even-spend': 'Even spend',
  'local-first': 'Local first',
};

export function CrewView({ thread, colors }: { thread: ChatThread; colors: Palette }) {
  const chain = thread.crewChain;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, `Crew: ${thread.crew ? safeText(thread.crew.name) : 'none'}`),
    ...(thread.crew?.members ?? []).map((member) =>
      h(
        Text,
        { key: member.role },
        `  ${member.role.padEnd(13)}`,
        FamilyMark({ family: member.selection.family, colors }),
        ` ${safeText(member.selection.model)} ${member.selection.effort}`,
      ),
    ),
    h(Text, null, `Flight mode: ${flightLabels[thread.flightMode]}`),
    h(Text, null, `Permission policy: ${policyLabels[thread.permissionPolicy]}`),
    h(
      Text,
      null,
      `Handoff: ${handoffLabels[thread.handoffMode]}, automatic ${thread.autoHandoff ? 'on' : 'off'}`,
    ),
    chain
      ? h(
          Text,
          { color: colors.muted },
          `Chain: ${chain.step}, ${chain.reviewRounds} review rounds, ${chain.fixes} fixes${chain.reason ? `. ${safeText(chain.reason)}` : ''}`,
        )
      : null,
    h(
      Text,
      { color: colors.muted },
      '1 Solo  2 Pair  3 Full crew  F flight mode  P policy  H handoff mode  A automatic handoff',
    ),
  );
}

export function ChangesView({
  changes,
  selected,
  thread,
  status,
  message,
  colors,
  width,
}: {
  changes: ChatChangesRead | null;
  selected: number;
  thread: ChatThread | null;
  status: ChatBranchStatus | null;
  message: string | null;
  colors: Palette;
  width: number;
}) {
  if (!changes) return h(Text, { color: colors.muted }, 'Reading changes.');
  const file = changes.files[selected] ?? null;
  const patch = (file?.patch ?? '').split('\n').slice(0, 400);
  const accepted = thread?.lastAcceptance ?? null;
  const pushed = thread?.lastPush ?? null;
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { bold: true },
      `Changes (${changes.files.length} ${changes.files.length === 1 ? 'file' : 'files'})`,
    ),
    changes.files.length === 0
      ? h(Text, { color: colors.muted }, 'The scratch copy matches the base.')
      : null,
    ...changes.files.map((entry, index) =>
      h(
        Text,
        { key: entry.path, inverse: index === selected },
        h(Text, { color: colors.green }, `+${entry.additions}`.padStart(6)),
        h(Text, { color: colors.red }, ` -${entry.deletions}`.padEnd(7)),
        safeText(entry.path),
      ),
    ),
    file
      ? h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'round',
            borderColor: colors.border,
            paddingX: 1,
            width,
          },
          ...patch.map((line, index) =>
            h(
              Text,
              {
                key: index,
                wrap: 'truncate-end',
                color: line.startsWith('+')
                  ? colors.green
                  : line.startsWith('-')
                    ? colors.red
                    : line.startsWith('@@')
                      ? colors.accent
                      : colors.muted,
              },
              safeText(line) || ' ',
            ),
          ),
          file.patch === null
            ? h(Text, { color: colors.muted }, 'No text diff for this file.')
            : null,
        )
      : null,
    accepted
      ? h(
          Text,
          null,
          `Accepted on ${accepted.branch}${accepted.commit ? ` at ${accepted.commit.slice(0, 7)}` : ''}`,
        )
      : null,
    pushed ? h(Text, null, `Pushed to ${pushed.remote}/${pushed.branch}`) : null,
    pushed?.pullRequestUrl ? h(Text, null, `Pull request: ${pushed.pullRequestUrl}`) : null,
    status ? CiStatus({ status, colors }) : null,
    message ? h(Text, { color: colors.amber }, safeText(message)) : null,
    h(
      Text,
      { color: colors.muted },
      'Up and Down pick a file. A Accept to branch  D Discard file  P Push  O Open pull request  Esc back',
    ),
  );
}

function CiStatus({ status, colors }: { status: ChatBranchStatus; colors: Palette }) {
  if (!status.runs)
    return h(Text, { color: colors.muted }, `CI: ${safeText(status.reason ?? 'unknown')}`);
  if (status.runs.length === 0) return h(Text, { color: colors.muted }, 'CI: no runs yet');
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'CI'),
    ...status.runs.map((run) =>
      h(
        Text,
        { key: run.id },
        h(
          Text,
          {
            color:
              run.conclusion === 'success'
                ? colors.green
                : run.conclusion && run.conclusion !== 'success'
                  ? colors.red
                  : colors.amber,
          },
          `  ${run.conclusion ?? run.status}`.padEnd(14),
        ),
        safeText(run.name),
      ),
    ),
  );
}

/** A catalog reason code as words, such as not-configured as Not configured. */
const reasonText = (reason: string | null) => {
  const text = safeText(reason ?? 'not connected').replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export type SettingsField =
  | 'theme'
  | 'animation'
  | 'selection'
  | 'permissionPolicy'
  | 'handoffMode';
export const settingsFields: readonly SettingsField[] = [
  'theme',
  'animation',
  'selection',
  'permissionPolicy',
  'handoffMode',
];

export function SettingsView({
  catalog,
  settings,
  field,
  status,
  nowMs,
  colors,
}: {
  catalog: ChatCatalogRead | null;
  settings: CliSettings;
  field: number;
  status: string | null;
  nowMs: number;
  colors: Palette;
}) {
  const values: Record<SettingsField, string> = {
    theme: settings.theme,
    animation: settings.animation,
    selection: settings.selection
      ? `${familyNames[settings.selection.family]} ${settings.selection.model} ${settings.selection.effort}`
      : 'most allowance left',
    permissionPolicy: policyLabels[settings.permissionPolicy],
    handoffMode: handoffLabels[settings.handoffMode],
  };
  const labels: Record<SettingsField, string> = {
    theme: 'Theme',
    animation: 'Animation',
    selection: 'New threads start on',
    permissionPolicy: 'New thread permission policy',
    handoffMode: 'New thread handoff mode',
  };
  return h(
    Box,
    { flexDirection: 'column', gap: 1 },
    h(Text, { bold: true }, 'Settings'),
    h(
      Box,
      { flexDirection: 'column' },
      ...settingsFields.map((name, index) =>
        h(
          Text,
          { key: name, inverse: index === field },
          `${labels[name].padEnd(30)} ${values[name]}`,
        ),
      ),
    ),
    ...(catalog?.families ?? []).map((entry) => {
      const groups = modelGroups(entry, settings.selection);
      const pinned = settings.familyModels[entry.family] ?? entry.defaultModel;
      return h(
        Box,
        {
          key: entry.family,
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: colors.border,
          paddingX: 1,
        },
        h(
          Text,
          null,
          FamilyMark({ family: entry.family, colors }),
          ` ${familyNames[entry.family]}  `,
          h(
            Text,
            { color: entry.connected ? colors.green : colors.muted },
            entry.connected ? 'Connected' : reasonText(entry.reason),
          ),
        ),
        UsageLine({ catalog, nowMs, colors, only: entry.family }),
        groups.live.length + groups.known.length > 0
          ? h(
              Text,
              { color: colors.muted, wrap: 'wrap' },
              `Models: ${[...groups.live, ...groups.known]
                .map((model) => `${model.model === pinned ? '●' : '○'} ${safeText(model.label)}`)
                .join('  ')}`,
            )
          : null,
        groups.hidden.length
          ? h(Text, { color: colors.muted }, `${groups.hidden.length} more on request`)
          : null,
      );
    }),
    status ? h(Text, { color: colors.amber }, safeText(status)) : null,
    h(
      Text,
      { color: colors.muted },
      'Up and Down pick a setting, Left and Right change it. M picks the default model of a family. C checks the sign-in. Saved to cli.json.',
    ),
  );
}

export function HelpView({ settings, colors }: { settings: CliSettings; colors: Palette }) {
  const actions = Object.keys(defaultKeys) as (keyof typeof defaultKeys)[];
  const words: Record<string, string> = {
    send: 'Send',
    newline: 'New line (or end a line with \\)',
    stop: 'Stop the reply, close a list or go back',
    threads: 'Threads',
    changes: 'Changes',
    settings: 'Settings',
    help: 'This help',
  };
  return h(
    Box,
    { flexDirection: 'column', gap: 1 },
    h(
      Box,
      { flexDirection: 'column' },
      h(Text, { bold: true }, 'Keys'),
      ...actions.map((action) =>
        h(
          Text,
          { key: action },
          `${keysFor(settings, action).map(keyLabel).join(', ').padEnd(24)} ${words[action]}`,
        ),
      ),
      h(Text, null, `${'Up, Down'.padEnd(24)} History, or move between lines`),
      h(Text, null, `${'Tab'.padEnd(24)} Take the highlighted completion`),
      h(Text, null, `${'Ctrl+C'.padEnd(24)} Leave, after asking while a reply runs`),
      h(Text, null, `${'Alt+R, Alt+G'.padEnd(24)} Retry a failed turn, regenerate the last reply`),
    ),
    h(
      Box,
      { flexDirection: 'column' },
      h(Text, { bold: true }, 'Slash commands'),
      ...slashCommands.map((command: SlashCommand) =>
        h(
          Text,
          { key: command.name },
          `${`/${command.name}${command.argument ? ` ${command.argument}` : ''}`.padEnd(24)} ${command.summary}`,
        ),
      ),
    ),
    h(
      Text,
      { color: colors.muted },
      '@path mentions a file or folder of the project. @/absolute/path or @~/path attaches a file from disk.',
    ),
  );
}

/** The message box with its caret, completions and attachments. */
export function ComposerView({
  composer,
  colors,
  placeholder,
  attachments,
  model,
  focused,
}: {
  composer: Composer;
  colors: Palette;
  placeholder: string;
  attachments: readonly string[];
  model: ReactNode;
  focused: boolean;
}) {
  const { text, caret } = composer;
  const before = text.slice(0, caret);
  const at = Array.from(text.slice(caret))[0] ?? ' ';
  const after = text.slice(caret + (at === ' ' && caret >= text.length ? 0 : at.length));
  const completion = composer.completion;
  return h(
    Box,
    { flexDirection: 'column' },
    completion
      ? h(
          Box,
          { flexDirection: 'column' },
          ...completion.items
            .slice(0, 8)
            .map((item, index) =>
              h(
                Text,
                { key: index, inverse: index === completion.index, color: colors.muted },
                'name' in item
                  ? `/${item.name}${item.argument ? ` ${item.argument}` : ''}  ${item.summary}`
                  : `${item.kind === 'folder' ? '▸' : ' '} ${safeText(item.path)}${item.kind === 'folder' ? '/' : ''}`,
              ),
            ),
        )
      : null,
    attachments.length
      ? h(
          Text,
          { color: colors.muted },
          attachments.map((path) => `⧉ ${safeText(path)}`).join('  '),
        )
      : null,
    h(
      Box,
      {
        borderStyle: 'round',
        borderColor: focused ? colors.accent : colors.border,
        paddingX: 1,
        flexDirection: 'column',
      },
      text === ''
        ? h(
            Text,
            null,
            h(Text, { inverse: focused }, ' '),
            h(Text, { color: colors.muted }, placeholder),
          )
        : h(
            Text,
            null,
            safeText(before),
            h(Text, { inverse: focused }, at === '\n' ? ' ' : safeText(at)),
            at === '\n' ? '\n' : '',
            safeText(after),
          ),
    ),
    h(Box, { gap: 2 }, model),
  );
}

/** The rows of one thread, oldest first. */
export function ThreadRows({
  items,
  thread,
  colors,
  width,
  frame,
  animation,
  showThinking,
  tryWith,
  promptFocus = false,
}: {
  promptFocus?: boolean;
  items: readonly ThreadItem[];
  thread: ChatThread | null;
  colors: Palette;
  width: number;
  frame: number;
  animation: Animation;
  showThinking: boolean;
  tryWith: (turnId: string) => readonly TryWith[];
}) {
  const rowNode = (item: ThreadItem): ReactNode => {
    switch (item.kind) {
      case 'user':
        return h(UserMessage, {
          key: item.key,
          text: item.text,
          files: item.files,
          pending: item.pending,
          colors,
        });
      case 'turn':
        return h(TurnCard, {
          key: item.key,
          turn: item.turn,
          colors,
          width,
          frame,
          animation,
          policy: thread?.permissionPolicy ?? null,
          showThinking,
          promptFocus,
        });
      case 'failure':
        return h(FailureLine, {
          key: item.key,
          failure: item.failure,
          tryWith: tryWith(item.turnId),
          colors,
        });
      case 'system':
        return h(Text, { key: item.key, color: colors.muted }, `· ${safeText(item.text)}`);
    }
    return null;
  };
  return h(
    Box,
    { flexDirection: 'column', gap: 1 },
    ...items.map(rowNode),
    thread ? h(QueuedList, { thread, colors }) : null,
    thread?.plan ? h(PlanCardView, { plan: thread.plan, flight: thread.flightMode, colors }) : null,
  );
}

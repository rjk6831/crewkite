import type {
  ChatChangeEntry,
  CommandResult,
  DesignFinding,
  DesignSystem,
  DesignSystemRecord,
} from '@crewkite/contracts';

// The design system and findings the browser preview answers with. A `state` query parameter
// picks one named state, so the screenshot script can open each of them on stable data:
// design-empty (the default), design-probing, design-describe-refused, design-record,
// design-conflict, design-stale, design-missing, design-invalid, findings, findings-none,
// findings-empty, findings-running, findings-error, findings-cap, findings-older and
// findings-states. Conflict and stale change the file or the record from the first read after the
// window is returned to, which is when the open editor reads again. Counting reads does not find
// that moment, since other parts of Settings read the design system too. setup-empty has no
// design system, as design-empty.

const px = (value: number) => ({
  $type: 'dimension' as const,
  $value: { value, unit: 'px' as const },
});
const color = (value: string, description?: string) => ({
  $type: 'color' as const,
  $value: value,
  ...(description ? { $description: description } : {}),
});
const layer = (y: number, blur: number, spread: number, shade: string) => ({
  color: shade,
  offsetX: { value: 0, unit: 'px' as const },
  offsetY: { value: y, unit: 'px' as const },
  blur: { value: blur, unit: 'px' as const },
  spread: { value: spread, unit: 'px' as const },
});

const SAMPLE: DesignSystem = {
  schema: 1,
  tokens: {
    color: {
      background: color('#ffffff', 'Page background.'),
      surface: color('#f6f7f9', 'Cards and raised panels.'),
      border: color('#d9dee7'),
      text: color('#1d2433', 'Body text.'),
      'text-muted': color('#5b6577', 'Secondary text and captions.'),
      'text-faint': color('#9aa3b2', 'Placeholders only.'),
      accent: color('#2f6feb', 'Links and the one primary action per view.'),
      'accent-ink': color('#ffffff', 'Text on the accent.'),
      danger: color('#c43d3d'),
      success: color('#2f8a4e'),
      scrim: color('oklch(0.2 0.02 260 / 0.6)', 'Behind a modal.'),
    },
    type: {
      sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui', 'sans-serif'] },
      mono: { $type: 'fontFamily', $value: ['JetBrains Mono', 'monospace'] },
      regular: { $type: 'fontWeight', $value: 400 },
      semibold: { $type: 'fontWeight', $value: 600 },
      sm: px(12),
      base: px(14),
      lg: px(18),
      xl: px(24),
      display: px(32),
      leading: { $type: 'number', $value: 1.5 },
    },
    spacing: {
      '1': px(4),
      '2': px(8),
      '3': px(12),
      '4': px(16),
      '6': px(24),
      '8': px(32),
      hairline: px(3),
    },
    radius: { sm: px(4), md: px(8), lg: px(12), pill: px(999) },
    shadow: {
      raised: { $type: 'shadow', $value: layer(1, 2, 0, '#1d24331a') },
      overlay: {
        $type: 'shadow',
        $value: [layer(8, 24, 0, '#1d243329'), layer(2, 6, 0, '#1d24331f')],
      },
      focus: { $type: 'shadow', $value: layer(0, 0, 3, '#2f6feb59') },
    },
    motion: {
      fast: { $type: 'duration', $value: { value: 120, unit: 'ms' } },
      base: { $type: 'duration', $value: { value: 200, unit: 'ms' } },
      standard: { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] },
      enter: { $type: 'cubicBezier', $value: [0, 0, 0.2, 1] },
    },
  },
  components: [
    {
      id: 'button',
      name: 'Button',
      do: ['One primary button per view.', 'Primary buttons fill with color.accent.'],
      dont: ['Do not use the accent for a destructive action.'],
      example: '<button class="button primary">Save changes</button>',
    },
    {
      id: 'card',
      name: 'Card',
      do: ['Pad cards with spacing.4.', 'Round with radius.md and lift with shadow.raised.'],
      dont: ['Do not nest a card in a card.'],
      example: '.card {\n  padding: var(--spacing-4);\n  border-radius: var(--radius-md);\n}',
    },
  ],
  rules: [
    {
      id: 'one-primary-action',
      text: 'One primary action per view, in color.accent.',
      do: ['Make the next step the primary action.'],
      dont: ['Do not put two primary buttons side by side.'],
      example: 'background: color.accent;',
    },
    {
      id: 'tokens-only',
      text: 'Take every color, space, radius and shadow from the tokens.',
      do: ['Use a spacing token for every margin, padding and gap.'],
      dont: ['Do not write a hex color in a component.'],
      example: 'gap: var(--spacing-3);',
    },
  ],
};

/** What a stylesheet import reads: tokens only, since CSS holds no rules. */
const CSS_DRAFT: DesignSystem = { ...structuredClone(SAMPLE), components: [], rules: [] };
const EDITED_ON_DISK: DesignSystem = (() => {
  const system = structuredClone(SAMPLE);
  system.tokens.color.accent = color('#1f5fd6', 'Links and the one primary action per view.');
  system.tokens.color['accent-hover'] = color('#174fb8');
  return system;
})();

const hash = (version: number) => version.toString(16).padStart(64, '0');
const findingId = (index: number) => `dsf_01${String(index).padStart(24, '0')}`;

// Each finding's line holds the value it names, so Changes at a line shows the literal.
const CARD_CSS = [
  '.card {',
  '  display: grid;',
  '  color: #2f8a4e;',
  '  border-radius: 6px;',
  '  background: var(--color-surface);',
  '  box-shadow: var(--shadow-raised);',
  '}',
  '',
  '.card-header {',
  '  display: flex;',
  '  align-items: center;',
  '  gap: var(--spacing-2);',
  '  border-bottom: 1px solid var(--color-border);',
  '  border-color: #3b82f6;',
  '}',
  '',
  '.card-title {',
  '  color: #2563eb;',
  '}',
  '',
  '.card-body {',
  '  gap: 13px;',
  '  color: var(--color-text);',
  '}',
];
const BUTTON_TSX = [
  'export function Button({ label }: { label: string }) {',
  '  return (',
  '    <button',
  '      type="button"',
  '      className="button"',
  "      style={{ fontFamily: 'Helvetica Neue', boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)' }}",
  '    >',
  '      {label}',
  '    </button>',
  '  );',
  '}',
];

/** The style files the findings point at, as Changes lists them. */
function changedFiles(): ChatChangeEntry[] {
  const added = (path: string, lines: string[], key: string): ChatChangeEntry => ({
    path,
    additions: lines.length,
    deletions: 0,
    patch: [
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      '',
    ].join('\n'),
    hunks: [
      { key, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, decision: 'undecided' },
    ],
    hunkControls: true,
    decided: false,
  });
  // The button file offsets its lines, so line 31 of the finding falls inside the hunk.
  const offset = Array.from({ length: 25 }, (_, index) => `// ${index + 1}`);
  return [
    added('src/components/Button.tsx', [...offset, ...BUTTON_TSX], 'c'.repeat(64)),
    added('src/components/card.css', CARD_CSS, 'e'.repeat(64)),
  ];
}

export function designPreview(state: string | null, projectId: string, taskId: string) {
  const findingsState = state?.startsWith('findings') ?? false;
  const startVersion = findingsState ? 5 : 4;
  let record: DesignSystemRecord | null =
    !state ||
    state === 'design-empty' ||
    state === 'design-probing' ||
    state === 'design-describe-refused' ||
    state === 'setup-empty'
      ? null
      : {
          projectId,
          path: 'design-system.json',
          version: startVersion,
          versionHash: hash(startVersion),
          delivery: true,
          updatedAt: '2026-11-18T14:02:00.000Z',
        };
  let system: DesignSystem | null = record ? structuredClone(SAMPLE) : null;
  let file: 'current' | 'changed' | 'missing' | 'invalid' | null = record
    ? state === 'design-missing'
      ? 'missing'
      : state === 'design-invalid'
        ? 'invalid'
        : 'current'
    : null;
  let returned = false;
  if (typeof window !== 'undefined')
    window.addEventListener('focus', () => {
      returned = true;
    });

  const finding = (
    index: number,
    path: string,
    line: number,
    rule: DesignFinding['rule'],
    found: string,
    nearestToken: string | null,
    extra: Partial<DesignFinding> = {},
  ): DesignFinding => ({
    id: findingId(index),
    taskId,
    file: path,
    line,
    rule,
    found,
    nearestToken,
    state: 'open',
    reason: null,
    versionHash: hash(5),
    ...extra,
  });
  const card = 'src/components/card.css';
  const button = 'src/components/Button.tsx';
  const three = () => [
    finding(1, card, 14, 'raw-color', '#3b82f6', 'color.accent'),
    finding(2, card, 22, 'off-scale-spacing', '13px', 'spacing.3'),
    finding(3, button, 31, 'unknown-font', 'Helvetica Neue', null),
  ];
  let findings: DesignFinding[] = [];
  let checked: string | null = null;
  if (state === 'findings' || state === 'findings-running' || state === 'findings-error') {
    findings = three();
    checked = hash(5);
  } else if (state === 'findings-empty') checked = hash(5);
  else if (state === 'findings-older') {
    findings = three().map((row) => ({ ...row, versionHash: hash(4) }));
    checked = hash(4);
  } else if (state === 'findings-states') {
    findings = [
      ...three(),
      // A tie between two steps names the larger one, as the check does.
      finding(4, card, 4, 'off-scale-radius', '6px', 'radius.md', { state: 'sent' }),
      finding(5, button, 31, 'unknown-shadow', '0 6px 18px rgba(0, 0, 0, 0.28)', 'shadow.overlay', {
        state: 'allowed',
        reason: "Matches the marketing site's modal until it moves to the tokens.",
      }),
      finding(6, card, 18, 'raw-color', '#2563eb', 'color.accent', {
        reason: 'Draft open. This resolves when a saved version holds the value.',
      }),
      finding(7, card, 3, 'raw-color', '#2f8a4e', 'color.success', {
        state: 'updated',
        reason: 'Version 5 holds this value as color.success.',
        versionHash: hash(4),
      }),
      finding(8, card, 9, 'off-scale-spacing', '10px', 'spacing.3', { state: 'resolved' }),
    ];
    checked = hash(5);
  } else if (state === 'findings-cap') {
    const rules: DesignFinding['rule'][] = ['raw-color', 'off-scale-spacing', 'off-scale-radius'];
    findings = Array.from({ length: 500 }, (_, index) => {
      const rule = rules[index % 3] as DesignFinding['rule'];
      return finding(
        index + 1,
        `src/legacy/screen-${String(Math.floor(index / 25) + 1).padStart(2, '0')}.css`,
        (index % 25) * 4 + 2,
        rule,
        rule === 'raw-color' ? '#3b82f6' : rule === 'off-scale-radius' ? '6px' : '13px',
        rule === 'raw-color'
          ? 'color.accent'
          : rule === 'off-scale-radius'
            ? 'radius.md'
            : 'spacing.3',
      );
    });
    checked = hash(5);
  }

  const applied = (data: unknown, next?: string) =>
    ({ outcome: 'applied', data, ...(next ? { next } : {}) }) as unknown as CommandResult;
  const blocked = (reason: string, next: string) =>
    ({ outcome: 'blocked', reason, next }) as CommandResult;
  const findingsRead = () =>
    applied({
      kind: 'design-findings',
      taskId,
      versionHash: checked,
      findings: structuredClone(findings),
    });

  function read(): CommandResult {
    if (record && returned && state === 'design-conflict' && file === 'current' && system) {
      file = 'changed';
      system = structuredClone(EDITED_ON_DISK);
    }
    if (record && returned && state === 'design-stale' && record.version === 4) {
      record = {
        ...record,
        version: 6,
        versionHash: hash(6),
        updatedAt: '2026-11-18T15:40:00.000Z',
      };
      system = structuredClone(EDITED_ON_DISK);
    }
    return applied(
      { kind: 'design-system', projectId, record, system, file },
      file === 'invalid'
        ? 'design-system.json: Line 12: tokens.spacing.3.$value: Invalid input: expected object, received string. Fix the file, then import it again.'
        : undefined,
    );
  }

  function command(
    name: string,
    payload: Record<string, unknown>,
  ): CommandResult | Promise<CommandResult> | null {
    switch (name) {
      case 'ReadDesignSystem':
        return read();
      case 'ImportDesignSystem': {
        // The probing state holds every answer back, so the list shows while it loads.
        if (state === 'design-probing') return new Promise<CommandResult>(() => {});
        const path = String(payload.path);
        const source = String(payload.source);
        if (path === 'src/styles/tokens.css')
          return applied({
            kind: 'design-system-draft',
            source,
            path,
            system: CSS_DRAFT,
            skipped: 14,
          });
        if (path === 'tailwind.config.js')
          return applied({
            kind: 'design-system-draft',
            source,
            path,
            system: CSS_DRAFT,
            skipped: 3,
          });
        if (path === 'tokens.json')
          return blocked(
            'design-file-invalid',
            'tokens.json: Line 7: tokens.color.accent.$value: Invalid input: expected string, received number.',
          );
        if (path === 'design-system.json' && record && system && file !== 'invalid')
          return applied({ kind: 'design-system-draft', source, path, system, skipped: 0 });
        return blocked('design-file-missing', `${path} is not in the project.`);
      }
      case 'DraftDesignSystem':
        if (state === 'design-describe-refused')
          return blocked(
            'provider-not-connected',
            'Connect a provider in Settings, then draft again.',
          );
        return applied({
          kind: 'design-system-draft',
          source: 'description',
          path: null,
          system: SAMPLE,
          skipped: 2,
        });
      case 'SaveDesignSystem': {
        const current = record?.version ?? 0;
        if (payload.expectedVersion !== current)
          return {
            outcome: 'stale-revision',
            revision: current,
            next: `The saved version is ${current}. Load it and review your changes against it.`,
          } as CommandResult;
        record = {
          projectId,
          path: String(payload.path),
          version: current + 1,
          versionHash: hash(current + 1),
          delivery: record?.delivery ?? true,
          updatedAt: '2026-11-18T14:20:00.000Z',
        };
        system = structuredClone(payload.body as DesignSystem);
        file = 'current';
        return applied({
          kind: 'design-system-saved',
          record,
          added: [],
          changed: [],
          removed: [],
        });
      }
      case 'SetDesignSystemDelivery':
        if (!record)
          return blocked('design-system-not-found', 'Save a design system for this project first.');
        record = { ...record, delivery: payload.enabled === true };
        return { outcome: 'applied' } as CommandResult;
      case 'RunDesignCheck':
        if (!record)
          return blocked('design-system-not-found', 'Save a design system for this project first.');
        // The running state holds its answer back, so the screenshot shows the check in flight.
        if (state === 'findings-running') return new Promise<CommandResult>(() => {});
        if (state === 'findings-error')
          return blocked(
            'copy-unreadable',
            'CrewKite could not read the copy, so the check did not run.',
          );
        if (state === 'findings-none') findings = three();
        checked = record.versionHash;
        findings = findings.map((row) => ({
          ...row,
          versionHash: record?.versionHash ?? row.versionHash,
        }));
        return findingsRead();
      case 'ReadDesignFindings':
        return findingsRead();
      case 'ResolveDesignFinding': {
        const row = findings.find((value) => value.id === payload.findingId);
        if (!row) return blocked('design-finding-not-found', 'Run the design check again.');
        if (row.state !== 'open' && row.state !== 'sent')
          return blocked(
            'design-finding-settled',
            `This finding is ${row.state}. Run the design check again to see what is left.`,
          );
        const action = payload.action;
        findings = findings.map((value) =>
          value.id !== row.id
            ? value
            : action === 'send-to-fixer'
              ? { ...value, state: 'sent', reason: null }
              : action === 'allow-once'
                ? { ...value, state: 'allowed', reason: String(payload.reason) }
                : {
                    ...value,
                    reason: 'Draft open. This resolves when a saved version holds the value.',
                  },
        );
        return findingsRead();
      }
      default:
        return null;
    }
  }

  return {
    command,
    /** Extra files for Changes while a findings state is open. */
    changes: () => (findingsState && state !== 'findings-cap' ? changedFiles() : []),
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesignSystem } from '@crewkite/contracts';
import {
  contrastLabel,
  contrastRatio,
  diffLines,
  EMPTY_SYSTEM,
  fromModel,
  type Rgba,
  revertLine,
  toModel,
} from './model.ts';

const hex = (value: string): Rgba => {
  const [red, green, blue, alpha = 255] = (value.slice(1).match(/../g) ?? []).map((pair) =>
    Number.parseInt(pair, 16),
  );
  return [red ?? 0, green ?? 0, blue ?? 0, alpha / 255];
};

// Claim: a swatch prints the WCAG ratio rounded down, so a pair just under 4.5 never prints as
// 4.5 and reads as passing; a translucent color is judged as painted over its background.
test('contrast prints the ratio rounded down and passes AA only from 4.5', () => {
  assert.equal(contrastLabel(contrastRatio(hex('#000000'), hex('#ffffff'))), '21.0:1 AA');
  assert.equal(
    contrastRatio(hex('#000000'), hex('#ffffff')),
    contrastRatio(hex('#ffffff'), hex('#000000')),
  );
  // #777 on white is 4.48:1. Rounding to the nearest tenth would print a passing 4.5.
  assert.equal(contrastLabel(contrastRatio(hex('#777777'), hex('#ffffff'))), '4.4:1 fails AA');
  assert.equal(contrastLabel(contrastRatio(hex('#767676'), hex('#ffffff'))), '4.5:1 AA');
  // Half-transparent black over white reads as the grey it paints, 4.00:1. Opaque black is 21:1.
  assert.equal(contrastLabel(contrastRatio(hex('#00000080'), hex('#ffffff'))), '4.0:1 fails AA');
});

const color = (value: string) => ({ $type: 'color' as const, $value: value });
const px = (value: number) => ({
  $type: 'dimension' as const,
  $value: { value, unit: 'px' as const },
});
const saved: DesignSystem = {
  ...EMPTY_SYSTEM,
  tokens: {
    ...EMPTY_SYSTEM.tokens,
    color: { brand: color('#2f6feb'), text: color('#1d2433'), danger: color('#c43d3d') },
    spacing: { '3': px(12), odd: px(13) },
    radius: { pill: px(999) },
  },
  rules: [
    {
      id: 'primary',
      text: 'One primary action per view.',
      do: [],
      dont: [],
      example: 'background: color.brand;',
    },
  ],
};

// Claim: the review lists what a save changes. A token that left one name and arrived under
// another with the same value is one rename, which lists the rules still naming the old token; a
// removal and an addition with different values stay two lines. Revert undoes one line only.
test('the diff reads a same-value move as a rename and reverts one line at a time', () => {
  const edited: DesignSystem = {
    ...saved,
    tokens: {
      ...saved.tokens,
      color: { accent: color('#2f6feb'), text: color('#111827'), warning: color('#b7791f') },
      spacing: { '3': px(16), odd: px(13), '6': px(24) },
      radius: {},
    },
  };
  const lines = diffLines(saved, edited);
  assert.deepEqual(
    lines.map(({ kind, text }) => `${kind}: ${text}`),
    [
      'renamed: Renamed color.brand to color.accent',
      'changed: Changed color.text #1d2433 to #111827',
      'added: Added color.warning #b7791f',
      'removed: Removed color.danger',
      'changed: Changed spacing.3 12px to 16px',
      'added: Added spacing.6 24px',
      'removed: Removed radius.pill',
    ],
  );
  assert.deepEqual(lines[0]?.named, ['One primary action per view.']);

  // Reverting the rename alone brings brand back and leaves every other edit in place.
  const model = revertLine(toModel(edited), saved, lines[0] as (typeof lines)[number]);
  const after = fromModel(model, () => true);
  assert.deepEqual(after.problems, []);
  assert.deepEqual(
    diffLines(saved, after.system).map(({ text }) => text),
    lines.slice(1).map(({ text }) => text),
  );
  // An unchanged load is no change at all.
  assert.deepEqual(diffLines(saved, fromModel(toModel(saved), () => true).system), []);
});

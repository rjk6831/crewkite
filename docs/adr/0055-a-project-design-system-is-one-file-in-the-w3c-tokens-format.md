# 0055. A project's design system is one file in the W3C design tokens format where it fits

- Status: Proposed
- Date: 2026-11-18

## Context

A project's design system has to reach every provider and every writing role in the same form, and the design check has to compare files with the same values the writers received. People already keep their tokens somewhere: CSS custom properties, a Tailwind config, a tokens JSON file or a DESIGN.md. Each tool reads its own.

The canonical copy needs one file format. It sits in the person's repository, so people and other tools read it as well as CrewKite.

The W3C Design Tokens Community Group publishes a JSON format for tokens. Each token has `$value`, `$type` and an optional `$description`, and groups nest freely and pass `$type` down. A dimension is `{ "value": 16, "unit": "px" }` and a duration is the same shape in ms or s. Its stable version writes a color as an object with a color space and components. A token can alias another with `{group.token}`.

## Decision

- A project has at most one design system, in one JSON file at a project-relative path the person picks. The default is `design-system.json` at the root.
- The file holds `schema`, `tokens`, `components` and `rules`. `tokens` has six fixed groups: color, type, spacing, radius, shadow and motion.
- Every token uses the format's `$type`, `$value` and `$description`. Dimensions are px or rem and durations are ms or s, in the format's `{ value, unit }` shape. Shadows, cubic Bezier curves, font families and font weights use the format's values.
- Colors are CSS color strings: hex, rgb(), hsl(), oklch() and the other color functions.
- There are no aliases. Every token holds its own value.
- Component rules and written rules are CrewKite's own: short do and don't lines with one example each. The format has nothing for them.
- The controller records each saved version and its hash. Saving writes the file in the person's working tree after they confirm the diff, and commits nothing. A save that would overwrite an edit made on disk refuses.
- An import reads CSS custom properties, a Tailwind config, a tokens file in the format, a DESIGN.md or an existing design system file into a draft and saves nothing. A Tailwind config is read as text and never run. A value that fits no token is counted and shown as skipped.

## Why

The format is the closest thing tokens have to a shared standard, and tools that read it exist. Following it means the `tokens` object reads close to what those tools expect, and a person who knows the format can read the file without a guide.

It does not fit everywhere. A color object with a color space and components is precise, but no import source holds colors that way. CSS, Tailwind and most tokens files hold strings. The editor checks a string with the browser's own parser, and the design check compares strings it finds in stylesheets. Converting every color to components and back would cost code at three ends and buy nothing a person sees. I chose CSS strings.

Aliases make a token set smaller and let one layer of a theme change in one place. They also make every reader resolve a graph, and a cycle or a missing target becomes an error the editor, the brief and the check would each have to handle. A system a model reads in its context should state each value plainly. I ruled aliases out. An import skips one and counts it.

Fixed groups tell the check where to look. Spacing found in a stylesheet is compared with the spacing group and a radius with the radius group. Free nesting would leave the check guessing which group means spacing.

The file lives in the repository so there is one source. A copy kept only in CrewKite's database would drift from what people and their other tools read. Writing the person's checkout departs from how threads work, where only acceptance writes, and only to a branch. I accept it for this one file because the person picks the path, sees the diff and confirms the save.

## Consequences

- A tool that expects the stable format's color objects will not read this file's colors. A converter is a small separate step if that ever matters.
- There are no themes or modes. An import keeps the first value under each name, which in a stylesheet is usually the light theme, and skips the rest.
- Typography, border, transition and gradient composites are skipped on import. A type scale is atomic tokens: families, weights, sizes and line heights.
- A save is a working-tree change. The person commits it with the rest of their work.
- `schema: 1` versions the shape. A change to it is a new schema number and a migration of the file.

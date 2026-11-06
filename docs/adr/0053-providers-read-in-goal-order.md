# 0053. Providers read in GOAL order

- Status: Proposed
- Date: 2026-11-04

## Context

CrewKite lists its four provider families in many places: the sidebar rail, the Settings cards, onboarding, the empty thread and the inspector's usage tab. Each place took its order from the family list in the contracts, OpenAI, Anthropic, Google, Local. Nobody chose that order. It is the order the families were added.

The kite in the logo has four panels, one colour per family: deep blue for Google, teal for OpenAI, coral for Anthropic and gold for Local. The rail draws a mark in each family's colour, so the order of the rows is something a person sees on every screen.

Google is not offered on Linux in this preview. Until now its Linux row read Connect, and Connect could only end in a refusal.

## Decision

Every list of providers a person sees reads Google, OpenAI, Anthropic, Local. The initials spell GOAL.

- One display order lives in the renderer, beside the rail's presentation code. The rail, the Settings cards, onboarding, the empty thread and the inspector take their order from it.
- Stored data, the contracts' family list, logs and exports keep their order. Only what is drawn changes, so no saved setup, receipt or test fixture moves.
- Every computer shows the same four rows. On Linux the Google row stays on the rail, greyed, with an empty bar and "Not on Linux" where the figure goes, and no Connect. Its Settings card stays in place, greyed, with the one line that says why, and no setup controls.

## Why

The rail is the first thing on screen and it never leaves. Its order should mean something.

The colours line up with the logo. Starting at the kite's top left panel and reading counter clockwise gives deep blue, teal, coral, gold. That is Google, OpenAI, Anthropic, Local. The rail now reads as the kite does, so the mark and the list support each other.

The rows alternate in height. Each row draws one bar per window its provider reports, so the rhythm follows each person's plans. When I chose the order, Google and Anthropic each reported a five-hour and a weekly window and drew two bars, Local showed one line, and OpenAI showed one while its credit state was the figure that counted, so the strip read two bars, one, two, one. On 6 November 2026 Anthropic removed the five-hour limit from Ultra (formerly Max 20x). A row with no five-hour window and a weekly window for one model, such as Fable, now shows the weekly window and that model's, so it keeps two bars and the rhythm holds. A plan that still reports a five-hour window shows five-hour and weekly as before. The colour order and the GOAL reading do not depend on any of this, and they are the reasons this order stands.

The initials spell GOAL. CrewKite exists to move a piece of work to a goal with a crew of models. The word is a small hook for a reader on the site, and it costs nothing once the order is fixed.

One order everywhere is the consistency rule. A person who learns the rail finds the same order in Settings and onboarding, so no list needs reading twice.

Keeping the Google row on Linux keeps the layout the same on every computer, so one set of screenshots and one set of instructions serve both platforms. A greyed row that says why is clearer than a missing row or a Connect that always refuses.

## Consequences

The release media and the site are captured after this change, in the new order.

The order is a display rule. A new family joins the display list in the renderer with a reason for its place, and the contracts' list stays as it is.

Linux packaging needs no change. The same renderer runs on both platforms, and the controller's existing platform gate decides the greyed row.

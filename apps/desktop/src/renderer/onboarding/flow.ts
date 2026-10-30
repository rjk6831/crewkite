import type { ChatFamily } from '@crewkite/contracts';

// The first-run welcome is three steps in one flow. This file holds the rules for which step
// shows, so the screen only draws what it is told and a test can read the rules directly.

export const ONBOARDING_STEPS = ['provider', 'project', 'message'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** `unread` until the desktop has said whether the welcome ended. */
export type OnboardingFlag = 'unread' | 'open' | 'finished';

/** The message the last step offers. It goes into the composer and is never sent for the person. */
export const SUGGESTED_FIRST_MESSAGE =
  'Give me a short tour of this repository and suggest one small first change.';

export type SetupState = {
  families: readonly { family: ChatFamily; connected: boolean }[];
  /** Whether the stored Google acknowledgement covers the terms text this build shows. */
  googleTermsAcknowledged: boolean;
  projectCount: number;
};

/**
 * Families a thread can use now. Google also needs the terms acknowledgement, because the
 * controller refuses a Google turn until the current text is acknowledged.
 */
export function readyFamilies(setup: SetupState): ChatFamily[] {
  return setup.families
    .filter(
      ({ family, connected }) =>
        connected && (family !== 'google' || setup.googleTermsAcknowledged),
    )
    .map(({ family }) => family);
}

export type OnboardingInput = {
  flag: OnboardingFlag;
  /** Null until the workspace and the model catalog have both been read. */
  setup: SetupState | null;
  /**
   * True once the welcome has been on screen this session, or the person asked for it. From then
   * on, adding a project or connecting a family must not make it vanish under them.
   */
  engaged: boolean;
  /** The furthest step the person has moved to. */
  reached: OnboardingStep;
};

export type OnboardingView =
  | { visible: false; reason: 'loading' | 'finished' | 'existing-user' }
  | {
      visible: true;
      step: OnboardingStep;
      ready: ChatFamily[];
      canContinue: boolean;
      skipLabel: 'Skip' | 'Skip for now';
    };

export function onboardingView(input: OnboardingInput): OnboardingView {
  const { flag, setup, engaged } = input;
  if (flag === 'unread' || !setup) return { visible: false, reason: 'loading' };
  if (flag === 'finished') return { visible: false, reason: 'finished' };
  const ready = readyFamilies(setup);
  // A person who already works here does not need a welcome.
  // A project is enough. Local is held in memory only, a sign-in can lapse and the Google
  // acknowledgement can go stale, so a ready family says nothing about who is new.
  if (setup.projectCount > 0 && !engaged) return { visible: false, reason: 'existing-user' };
  // A step is only shown while what it needs still holds. A family that disconnects sends the
  // person back to the first step, and a missing project back to the second.
  const wanted = ONBOARDING_STEPS.indexOf(input.reached);
  const allowed = ready.length === 0 ? 0 : setup.projectCount === 0 ? 1 : 2;
  const step = ONBOARDING_STEPS[Math.min(wanted, allowed)];
  return {
    visible: true,
    step,
    ready,
    canContinue:
      step === 'provider' ? ready.length > 0 : step === 'project' ? setup.projectCount > 0 : true,
    skipLabel: step === 'provider' && ready.length === 0 ? 'Skip for now' : 'Skip',
  };
}

export const stepAfter = (step: OnboardingStep): OnboardingStep =>
  ONBOARDING_STEPS[Math.min(ONBOARDING_STEPS.indexOf(step) + 1, ONBOARDING_STEPS.length - 1)];
export const stepBefore = (step: OnboardingStep): OnboardingStep =>
  ONBOARDING_STEPS[Math.max(ONBOARDING_STEPS.indexOf(step) - 1, 0)];

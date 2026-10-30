import { googleTermsCurrent } from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatalog } from '../settings/use-catalog.ts';
import type { Workspace } from '../source.ts';
import {
  type OnboardingFlag,
  type OnboardingStep,
  onboardingView,
  type SetupState,
  stepAfter,
  stepBefore,
} from './flow.ts';

/**
 * Where the first-run welcome stands. The flag that says it ended lives in the desktop main
 * process, so it survives a reload and a cleared page store. A view without that bridge, such as
 * the preview, keeps the flag in memory for the session.
 */
export function useOnboarding(workspace: Workspace) {
  const { source, header, projectPage, projects } = workspace;
  const store = source?.onboarding;
  const [flag, setFlag] = useState<OnboardingFlag>('unread');
  const [reached, setReached] = useState<OnboardingStep>('provider');
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    if (!source) return;
    if (!store) {
      setFlag('open');
      return;
    }
    let active = true;
    store.finished().then(
      (finished) => {
        if (active) setFlag(finished ? 'finished' : 'open');
      },
      () => {
        if (active) setFlag('open');
      },
    );
    return () => {
      active = false;
    };
  }, [source, store]);
  // The catalog is only read while the welcome can still show, so a person past it pays for no
  // extra reads.
  const { catalog, error, modelRead } = useCatalog(flag === 'open' ? source : undefined, header);
  const setup = useMemo<SetupState | null>(
    () =>
      header && catalog && projectPage
        ? {
            families: catalog.families.map(({ family, connected }) => ({ family, connected })),
            googleTermsAcknowledged: googleTermsCurrent(header.googleAcpSetup?.googleTerms),
            projectCount: projects.length,
            projectsWithThreads: projects.filter(({ taskCount }) => taskCount > 0).length,
          }
        : null,
    [header, catalog, projectPage, projects],
  );
  const view = onboardingView({ flag, setup, engaged, reached });
  const persist = useCallback(
    (finished: boolean) => {
      setFlag(finished ? 'finished' : 'open');
      // A write that fails leaves the welcome ended for this session and asks again next launch.
      void store?.setFinished(finished).catch(() => {});
    },
    [store],
  );
  const shown = view.visible;
  const settled = !view.visible && view.reason === 'existing-user';
  useEffect(() => {
    if (shown) setEngaged(true);
  }, [shown]);
  // A person who already works here never meets it, including after a sign-in lapses.
  useEffect(() => {
    if (settled) persist(true);
  }, [settled, persist]);
  return {
    view,
    catalog,
    catalogError: error,
    modelRead,
    next: () => setReached((step) => stepAfter(view.visible ? view.step : step)),
    back: () => setReached((step) => stepBefore(view.visible ? view.step : step)),
    /** Skip and finish both end it for good. */
    finish: () => persist(true),
    /** Settings > General, Show the welcome again. */
    restart: () => {
      setReached('provider');
      setEngaged(true);
      persist(false);
    },
  };
}

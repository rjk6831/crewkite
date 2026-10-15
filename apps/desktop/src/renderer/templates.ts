import {
  EffectSchema,
  type Policy,
  PolicySchema,
  type ReviewMethod,
  ReviewMethodIdSchema,
  type Role,
  RoleSchema,
  type Route,
  RouteSchema,
} from '@crewkite/contracts';

export interface SavedTeam {
  name: string;
  roles: Role[];
  routes: Route[];
  preferences: Omit<Policy, 'effects'>;
  gates: Array<{
    action: Policy['effects'][number]['action'];
    methodId?: ReviewMethod['id'];
    cycle?: number;
    mode: 'ask' | 'once';
  }>;
}

const key = 'crewkite-custom-teams-v1';

export function loadTeams(): SavedTeam[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(stored) || stored.length > 20) return [];
    return stored.flatMap((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.name !== 'string' ||
        !value.name.trim() ||
        value.name.length > 80 ||
        !value.preferences ||
        typeof value.preferences !== 'object'
      )
        return [];
      const roles = RoleSchema.array().max(6).safeParse(value.roles);
      const routes = RouteSchema.array().max(100).safeParse(value.routes);
      const policy = PolicySchema.safeParse({
        ...value.preferences,
        reserves: value.preferences.reserves ?? [],
        effects: [],
      });
      if (
        !roles.success ||
        !routes.success ||
        !policy.success ||
        new Set(roles.data.map(({ role }) => role)).size !== roles.data.length
      )
        return [];
      const { effects: _effects, ...preferences } = policy.data;
      const gates: SavedTeam['gates'] = [];
      if (Array.isArray(value.gates) && value.gates.length <= 100) {
        for (const gate of value.gates) {
          if (!gate || typeof gate !== 'object') continue;
          const action = EffectSchema.shape.action.safeParse(gate.action);
          if (action.success && (gate.mode === 'ask' || gate.mode === 'once')) {
            if (action.data === 'run-review') {
              const method = ReviewMethodIdSchema.safeParse(gate.methodId);
              if (
                method.success &&
                Number.isInteger(gate.cycle) &&
                gate.cycle >= 1 &&
                gate.cycle <= 3
              )
                gates.push({
                  action: action.data,
                  methodId: method.data,
                  cycle: gate.cycle,
                  mode: gate.mode,
                });
            } else gates.push({ action: action.data, mode: gate.mode });
          }
        }
      }
      return [
        { name: value.name.trim(), roles: roles.data, routes: routes.data, preferences, gates },
      ];
    });
  } catch {
    return [];
  }
}

export function saveTeam(
  name: string,
  roles: Role[],
  routes: Route[],
  policy: Policy,
): SavedTeam[] {
  if (!name.trim() || name.trim().length > 80)
    throw new Error('A team name must be between 1 and 80 characters.');
  // Reusable preferences exclude task grants, expiry and consumption receipts.
  const { effects: _effects, ...preferences } = PolicySchema.parse(policy);
  const team: SavedTeam = {
    name: name.trim(),
    roles: RoleSchema.array().max(6).parse(roles),
    routes: routes.filter(
      (route) =>
        policy.reserves.some(({ routeId }) => routeId === route.id) ||
        roles.some(
          ({ routeId, approvedFallbacks }) =>
            routeId === route.id || approvedFallbacks.includes(route.id),
        ),
    ),
    preferences,
    gates: policy.effects.flatMap((grant): SavedTeam['gates'] => {
      const mode = grant.usesRemaining === 1 ? ('once' as const) : ('ask' as const);
      if (grant.action !== 'run-review') return [{ action: grant.action, mode }];
      const [id, cycleText] = grant.target.split('/cycle-');
      const method = ReviewMethodIdSchema.safeParse(id);
      return method.success
        ? [{ action: grant.action, methodId: method.data, cycle: Number(cycleText), mode }]
        : [];
    }),
  };
  const current = loadTeams();
  const teams = [team, ...current.filter((value) => value.name !== team.name)].slice(0, 20);
  localStorage.setItem(key, JSON.stringify(teams));
  return teams;
}

export const roleLabels: Record<Role['role'], string> = {
  coder: 'Builder',
  reviewer: 'Reviewer',
  lead: 'Architect',
  orchestrator: 'Coordinator',
  advisor: 'Advisor',
  overseer: 'Overseer',
};

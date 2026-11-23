import { type Command, CommandSchema } from '@crewkite/contracts';

/**
 * The window runs one changing command at a time, and the lock keeps that command and its exact
 * retry in order. A command with no expectedRevision changes no record, so it neither takes the
 * lock nor waits on it.
 */
const WITHOUT_REVISION = CommandSchema.options
  .filter((option) => !('expectedRevision' in option.shape))
  .map((option) => option.shape.command.value);

/**
 * Commands that carry an expectedRevision and still skip the lock, because they run long, belong
 * to another record or must get through while a command waits.
 */
const SKIPS_BY_NAME = new Set<Command['command']>([
  'SaveChatPrompt',
  'DeleteChatPrompt',
  'AddProjectNote',
  'EditProjectNote',
  'RemoveProjectNote',
  'SaveCrew',
  'DeleteCrew',
  'SetDefaultCrew',
  'ImportSavedCrews',
  'SetCreditSpending',
  // A sign-in check waits up to 30 s on the connection's own client. It holds no lock, so the
  // window stays usable meanwhile, and it writes no receipt: a repeat only reads again.
  'ProveConnection',
  'AssignConnection',
  'UnassignConnection',
  'SetKeepConnected',
  'DisconnectConnection',
  'ForgetConnection',
  'SetFamilyModel',
  'RefreshChatModels',
  'PushChatBranch',
  'OpenChatPullRequest',
  'CheckChatMerge',
  'CancelAcceptance',
  // A copy can take minutes. It holds no lock, so the window stays usable meanwhile, and
  // it writes no receipt: the controller refuses a second one for the same copy.
  'PrepareDependencies',
  // A draft saves nothing and can take three minutes, so it must not hold the window's lock.
  'DraftDesignSystem',
  'ProposeRemoteEffect',
  'ConfirmRemoteEffect',
  'CancelRemoteEffect',
  'ReconcileRemoteEffect',
  'SettleRemoteEffect',
  'PrepareProjectCommand',
  'StartProjectCommand',
  'ReadGitHub',
  'StopProjectOperation',
  'ObserveUsage',
  'RefreshAnthropicUsage',
  'StopAnthropicUsage',
  'CheckNativeConnection',
  'InstallGoogleAcp',
  'StopGoogleAcpInstall',
  'InitializeGoogleAcp',
  'AuthenticateGoogleAcp',
  'DiscoverGoogleAcp',
  'StopGoogleAcpSetup',
  'RecoverGoogleMetadata',
  'RefreshGoogleAcpModels',
  'AcknowledgeGoogleTerms',
  'SignInOpenAi',
  'SignOutOpenAi',
  'SignOutProvider',
  'ConfigureLocal',
  'BeginLocalConnectionInput',
  'CancelLocalConnectionInput',
  'DisconnectLocal',
  'RefreshLocalModels',
  'SelectLocalModel',
]);

const SKIPS_LOCK = new Set<string>([...SKIPS_BY_NAME, ...WITHOUT_REVISION]);

export function takesWindowLock(command: string): boolean {
  return !SKIPS_LOCK.has(command);
}

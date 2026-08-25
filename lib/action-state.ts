/**
 * What every Server Action in this app returns to `useActionState`.
 *
 * Seven files declared this same pair independently (`AccountState`,
 * `LoginState`, `ReviewState`, `SettingsState` twice, `PortfolioActionState`,
 * `AllocationActionState`) purely because there was no shared home for it.
 * They now alias this, so `<FormStatus>` can render any of them.
 *
 * Exactly one of the two is set on any given return: `error` when the action
 * refused, `ok` when it succeeded. Neither is set for the initial state.
 */
export interface ActionState {
  readonly error?: string
  readonly ok?: string
}

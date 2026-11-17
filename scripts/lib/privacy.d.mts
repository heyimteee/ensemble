export interface PrivateIdentity {
  users: string[]
  hosts: string[]
  paths: string[]
  markers: string[]
}

export interface PrivateIdentityOverrides {
  username?: string
  hostname?: string
  home?: string
}

export function privateIdentity(overrides?: PrivateIdentityOverrides): PrivateIdentity
export function privacyMarkers(overrides?: PrivateIdentityOverrides): string[]
export function privacyViolations(text: string, overrides?: PrivateIdentityOverrides): string[]

export const ONBOARDING_COMPLETION_KEY = 'aervox.onboarding.completed.v1';
export interface OnboardingStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function hasCompletedOnboarding(storage?: OnboardingStorage): boolean {
  try { return storage?.getItem(ONBOARDING_COMPLETION_KEY) === 'true'; } catch { return false; }
}
export function markOnboardingCompleted(storage?: OnboardingStorage): void {
  try { storage?.setItem(ONBOARDING_COMPLETION_KEY, 'true'); } catch { /* Still complete this window when storage is unavailable. */ }
}

/** The host reports saved model state without exposing provider credentials. */
export interface OnboardingModelStatus {
  state: 'loading' | 'configured' | 'unconfigured' | 'error';
  busy: boolean;
  modelId?: string;
}

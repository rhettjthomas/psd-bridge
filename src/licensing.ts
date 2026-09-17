/**
 * The only module that talks to figma.payments.
 *
 * Stubbed to "paid" during development so the plugin never locks out its own
 * developer. To turn on payments for the Community release, set LICENSING_ENABLED
 * to true after confirming Figma's current seller requirements.
 */

const LICENSING_ENABLED = false;

export function isLicensed(): boolean {
  if (!LICENSING_ENABLED) return true;
  return figma.payments?.status.type === 'PAID';
}

/** Opens Figma's checkout. Resolves to whether the user is now licensed. */
export async function requestLicense(): Promise<boolean> {
  if (!LICENSING_ENABLED) return true;
  if (!figma.payments) return false;
  await figma.payments.initiateCheckoutAsync({ interstitial: 'PAID_FEATURE' });
  return isLicensed();
}

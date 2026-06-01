// Type declarations for the in-page checkin engine (plain JS that runs in the
// browser context). These signatures are what the headless endpoint and tests
// rely on.
export function bakeCreativeInPage(
  creativeUrl: string,
  sizeStr: string
): {
  filled: number;
  detail: string[];
  source: string | null;
  slots: Array<{ id: string; booked: string; mode: string; filled: boolean }>;
  exact: number;
  approx: number;
};

export function cleanOverlaysInPage(): number;
export function autoScrollInPage(): Promise<void>;
export function dismissConsentInPage(): boolean;

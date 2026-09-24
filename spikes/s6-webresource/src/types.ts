export type Spike = 'env' | 'S6' | 'org' | 'S1' | 'S2' | 'S5';
export type Status = 'pass' | 'fail' | 'warn' | 'info';

export interface CheckResult {
  id: string;
  spike: Spike;
  title: string;
  status: Status;
  summary: string;
  details?: unknown;
}

export type CheckOutcome = Omit<CheckResult, 'id' | 'spike' | 'title'>;

/** Runs one check; any thrown error becomes a `fail` result instead of stopping the run. */
export async function check(
  id: string,
  spike: Spike,
  title: string,
  fn: () => Promise<CheckOutcome>,
): Promise<CheckResult> {
  try {
    return { id, spike, title, ...(await fn()) };
  } catch (error) {
    return { id, spike, title, status: 'fail', summary: error instanceof Error ? error.message : String(error) };
  }
}

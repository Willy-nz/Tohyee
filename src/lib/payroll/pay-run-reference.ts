/** The journal reference and the name people use for a pay run (PRUN1). */
export function payRunReference(runNumber: string | number): string {
  return `PAYRUN-${runNumber}`;
}

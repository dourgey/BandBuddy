/** AI service errors are already redacted in the main process; preserve provider diagnostics. */
export function aiUiError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').slice(0, 800) || fallback
}

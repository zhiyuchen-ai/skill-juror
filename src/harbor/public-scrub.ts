const MAX_PUBLIC_DIAGNOSTIC_LENGTH = 1200;

export function scrubPublicDiagnostic(value: string): string {
  let scrubbed = value;
  scrubbed = scrubbed.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "<redacted-key>");
  scrubbed = scrubbed.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|BASE_URL|PROXY|URL)[A-Za-z0-9_]*\s*(?::|=)\s*)(["']?)([^"',\s}\\\]]+)/gi,
    (_match: string, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
  );
  scrubbed = scrubbed.replace(/\bhttps?:\/\/[^\s"'\\<>]+/g, "<url>");
  scrubbed = scrubbed.replace(/\b[A-Za-z]:\\[^\s"',)}\]]+/g, "<path>");
  scrubbed = scrubbed.replace(/\/(?:home|root|tmp|var|mnt|Users)\/[^\s"',)}\]]+/g, "<path>");
  return scrubbed.length > MAX_PUBLIC_DIAGNOSTIC_LENGTH
    ? `${scrubbed.slice(0, MAX_PUBLIC_DIAGNOSTIC_LENGTH)}...`
    : scrubbed;
}

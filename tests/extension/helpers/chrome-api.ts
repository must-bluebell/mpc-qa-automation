/** Chrome APIs read by the extension tests; never mutates installed permissions or storage. */
export interface ChromeApi {
  runtime: {
    getManifest(): {
      version: string;
      content_scripts?: unknown[];
      externally_connectable?: unknown;
      content_security_policy?: string | { extension_pages?: string };
    };
  };
  permissions: {
    getAll(): Promise<{ permissions?: string[]; origins?: string[] }>;
  };
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>> };
  };
}

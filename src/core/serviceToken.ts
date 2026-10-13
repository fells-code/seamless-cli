// The variable an application reads its Seamless service token from. The auth
// server reads the same value as API_SERVICE_TOKEN, which is also what apps read
// before seamless-cli 0.24.0 and seamless-templates' rename.
export const SERVICE_TOKEN_VAR = "SEAMLESS_SERVICE_TOKEN";
export const LEGACY_SERVICE_TOKEN_VAR = "API_SERVICE_TOKEN";

/**
 * The name to write an app's service token under, given its existing .env. A
 * project that already has the legacy name and not the new one has code reading
 * the legacy name, so the token goes there rather than into a second variable the
 * app never reads.
 */
export function appServiceTokenVar(existing: Record<string, string>): string {
  if (LEGACY_SERVICE_TOKEN_VAR in existing && !(SERVICE_TOKEN_VAR in existing)) {
    return LEGACY_SERVICE_TOKEN_VAR;
  }
  return SERVICE_TOKEN_VAR;
}

export function legacyServiceTokenNote(file: string): string {
  return `Updated ${LEGACY_SERVICE_TOKEN_VAR} in ${file} in place, because this project reads that name. New projects use ${SERVICE_TOKEN_VAR}; rename it in the file and in your code together if you want to move.`;
}

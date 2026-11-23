import { isRetryableMessage, retryBackoffMs, shouldRetryHttpStatus } from "./briefingLogic";

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err && "message" in err) {
    return String((err as { message?: unknown }).message || err);
  }
  return String(err);
}

export function isRetryableError(err: unknown): boolean {
  if (typeof err === "object" && err) {
    const record = err as { statusCode?: unknown; code?: unknown; status?: unknown };
    const candidates = [record.statusCode, record.code, record.status];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && shouldRetryHttpStatus(candidate)) return true;
    }
  }
  return isRetryableMessage(errorMessage(err));
}

export function withGasRetry<T>(label: string, fn: () => T, maxAttempts = 3): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === maxAttempts - 1) throw err;
      const wait = retryBackoffMs(attempt);
      console.warn(
        `${label} fehlgeschlagen (Versuch ${attempt + 1}/${maxAttempts}, ${errorMessage(err)}). Neuer Versuch in ${wait} ms.`,
      );
      Utilities.sleep(wait);
    }
  }
  throw lastError;
}

export function fetchWithRetry(
  label: string,
  url: string,
  options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions,
  maxAttempts = 3,
): GoogleAppsScript.URL_Fetch.HTTPResponse {
  let lastResponse: GoogleAppsScript.URL_Fetch.HTTPResponse | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: GoogleAppsScript.URL_Fetch.HTTPResponse;
    try {
      response = UrlFetchApp.fetch(url, { ...options, muteHttpExceptions: true });
    } catch (err) {
      if (!isRetryableError(err) || attempt === maxAttempts - 1) throw err;
      const wait = retryBackoffMs(attempt);
      console.warn(`${label}: Abruf fehlgeschlagen, neuer Versuch in ${wait} ms. ${errorMessage(err)}`);
      Utilities.sleep(wait);
      continue;
    }

    const code = response.getResponseCode();
    if (shouldRetryHttpStatus(code) && attempt < maxAttempts - 1) {
      const wait = retryBackoffMs(attempt);
      console.warn(`${label}: HTTP ${code}, neuer Versuch in ${wait} ms.`);
      Utilities.sleep(wait);
      lastResponse = response;
      continue;
    }
    return response;
  }
  if (!lastResponse) throw new Error(`${label}: kein Antwortversuch`);
  return lastResponse;
}

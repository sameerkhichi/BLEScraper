import type { AppSettings, UploadPayload } from '../model';

export async function postPayload(settings: AppSettings, payload: UploadPayload): Promise<void> {
  const url = settings.apiUrl.trim();
  if (!url) {
    throw new Error('Add the Arduino URL in Settings.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The API URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The API URL needs to start with http:// or https://.');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain',
    'Content-Type': 'application/json',
  };
  if (settings.apiKey.trim()) {
    headers['X-Api-Key'] = settings.apiKey.trim();
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`The server responded with ${response.status}.`);
  }
}

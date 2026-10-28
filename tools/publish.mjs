// Uploads and publishes a zip to the Chrome Web Store (API v2).
// Run: node tools/publish.mjs release/hush-<version>.zip
//
// Environment variables (the GitHub Actions secrets):
//   CWS_PUBLISHER_ID, CWS_EXTENSION_ID
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN
// The first version is uploaded by hand from the Developer Dashboard; the API only updates.

import { readFile } from 'node:fs/promises';

const env = (k) => process.env[k] || (() => { throw new Error(`missing ${k}`); })();
const file = process.argv[2];
if (!file) throw new Error('usage: node tools/publish.mjs <archive.zip>');

const publisher = env('CWS_PUBLISHER_ID');
const item = env('CWS_EXTENSION_ID');
const base = `https://chromewebstore.googleapis.com/v2/publishers/${publisher}/items/${item}`;

async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('CWS_CLIENT_ID'),
      client_secret: env('CWS_CLIENT_SECRET'),
      refresh_token: env('CWS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token: ${res.status} ${JSON.stringify(json)}`);
  return json.access_token;
}

async function call(method, url, token, body) {
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}` }, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url.replace(base, '')}: ${res.status} ${text}`);
  return json;
}

const token = await accessToken();
const zip = await readFile(file);

let upload = await call('POST', `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisher}/items/${item}:upload`, token, zip);
console.log('upload:', JSON.stringify(upload));
for (let i = 0; i < 30 && upload.uploadState === 'UPLOAD_IN_PROGRESS'; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  upload = await call('GET', `${base}:fetchStatus`, token);
  console.log('status:', JSON.stringify(upload));
}
const state = upload.uploadState || upload.lastAsyncUploadState;
if (state && !/SUCCEEDED|SUCCESS/.test(state)) throw new Error(`upload failed: ${JSON.stringify(upload)}`);

const published = await call('POST', `${base}:publish`, token);
console.log('publish:', JSON.stringify(published));

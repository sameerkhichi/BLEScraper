import { readFileSync, writeFileSync } from 'node:fs';

const ascAppId = process.env.ASC_APP_ID ?? '';
const appleTeamId = process.env.APPLE_TEAM_ID ?? '';

if (!/^\d+$/.test(ascAppId)) {
  console.error('Set ASC_APP_ID to the numeric App Store Connect app id.');
  process.exit(1);
}

if (!/^[A-Z0-9]{10}$/.test(appleTeamId)) {
  console.error('Set APPLE_TEAM_ID to the 10-character Apple Team ID.');
  process.exit(1);
}

const path = new URL('../eas.json', import.meta.url);
const eas = JSON.parse(readFileSync(path, 'utf8'));
eas.submit.production.ios.ascAppId = ascAppId;
eas.submit.production.ios.appleTeamId = appleTeamId;
writeFileSync(path, `${JSON.stringify(eas, null, 2)}\n`);

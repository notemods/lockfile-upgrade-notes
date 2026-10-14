// End-to-end smoke test in a real Obsidian (wdio-obsidian-service). Run: npm run build && npm run test:e2e
// OBSIDIAN_VERSIONS is a space separated list of app/installer pairs. CI runs "earliest/earliest" and
// "latest/latest" on ubuntu-latest under Xvfb. "earliest" is exactly manifest minAppVersion: fx check
// (tools/min-app-version.mjs) requires it to be the first PUBLIC release at or above the API floor, because
// Obsidian ships most x.y.0 to x.y.3 builds to Insiders only and those need an account to download.
// Set OBSIDIAN_EMAIL and OBSIDIAN_PASSWORD (an Insiders account) and OBSIDIAN_ALLOW_BETA=1 to test an Insiders floor.
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ObsidianLauncher from 'obsidian-launcher';

const cacheDir = process.env.OBSIDIAN_CACHE ?? path.join(os.homedir(), '.cache', 'obsidian-launcher');
const { minAppVersion } = JSON.parse(readFileSync('manifest.json', 'utf8')) as { minAppVersion: string };

/** minAppVersion itself, after checking that it is a public (non-Insiders) desktop release. */
async function earliestPublic(): Promise<string> {
	if (process.env.OBSIDIAN_ALLOW_BETA === '1') return 'earliest';
	const versions = await new ObsidianLauncher({ cacheDir }).getVersions();
	const v = versions.find((x) => x.version === minAppVersion);
	if (!v || v.isBeta || !v.downloads?.asar) throw new Error(`minAppVersion ${minAppVersion} is not a public Obsidian desktop release; fx check requires one (tools/data/obsidian-public-releases.json)`);
	return minAppVersion;
}

const pairs = (process.env.OBSIDIAN_VERSIONS ?? 'earliest/earliest latest/latest')
	.split(/\s+/)
	.filter(Boolean)
	.map((pair) => pair.split('/'));
const versions = await Promise.all(
	pairs.map(async ([app, installer]) => [app === 'earliest' ? await earliestPublic() : (app ?? 'latest'), installer ?? 'earliest']),
);

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: Number(process.env.WDIO_MAX_INSTANCES ?? 1),
	capabilities: versions.map(([appVersion, installerVersion]) => ({
		browserName: 'obsidian',
		browserVersion: appVersion,
		'wdio:obsidianOptions': {
			installerVersion,
			plugins: ['.'],
			vault: 'test/e2e/vault',
		},
	})),
	services: ['obsidian'],
	reporters: ['obsidian'],
	// Shared download cache for every product; CI caches the same folder.
	cacheDir,
	mochaOpts: { ui: 'bdd', timeout: 120_000 },
	logLevel: 'warn',
};

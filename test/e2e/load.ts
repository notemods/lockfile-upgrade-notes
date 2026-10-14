// Shared smoke checks: the plugin is on, and turning it off and on again logs no errors.
import { browser } from '@wdio/globals';
import { readFileSync } from 'node:fs';

export const pluginId = (JSON.parse(readFileSync('manifest.json', 'utf8')) as { id: string }).id;

export interface LoadState {
	enabled: boolean;
	reloaded: boolean;
	errors: string[];
}

/** Disables and re-enables the plugin inside Obsidian while recording console.error calls and uncaught errors. */
export async function reloadPlugin(id: string): Promise<LoadState> {
	return browser.executeObsidian(async ({ app }, pluginId) => {
		interface Plugins {
			enabledPlugins: Set<string>;
			plugins: Record<string, unknown>;
			disablePlugin(id: string): Promise<void>;
			enablePlugin(id: string): Promise<boolean>;
		}
		const plugins = (app as unknown as { plugins: Plugins }).plugins;
		const errors: string[] = [];
		const original = console.error;
		const onError = (e: ErrorEvent) => errors.push(String(e.message));
		const onReject = (e: PromiseRejectionEvent) => errors.push(String(e.reason));
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '));
			original(...args);
		};
		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onReject);
		try {
			const enabled = plugins.enabledPlugins.has(pluginId) && pluginId in plugins.plugins;
			await plugins.disablePlugin(pluginId);
			const reloaded = await plugins.enablePlugin(pluginId);
			await Promise.resolve();
			return { enabled, reloaded, errors };
		} finally {
			console.error = original;
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onReject);
		}
	}, id);
}

/** Text of the newest notice, or "" if none is shown. */
export async function lastNotice(): Promise<string> {
	const notices = await browser.$$('.notice');
	const count = await notices.length;
	return count > 0 ? await notices[count - 1]!.getText() : '';
}

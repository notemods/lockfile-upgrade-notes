// The "More from NoteMods" card for setting tabs that use getSettingDefinitions() (Obsidian 1.13 and later).
// A separate entry point, so a product on an older minAppVersion can use renderHelloSettings() from the index
// without pulling the 1.13 settings types into its bundle.
import type { SettingDefinitionItem } from 'obsidian';
import { HELLO_BRAND, HELLO_TOGGLE_DESC, appendHelloLinks, currentHello, helloAboutText, type HelloController } from './index';

/**
 * One settings group: the "Show what's new after updates" toggle and the quiet NoteMods card. Without an argument
 * it uses the controller of this plugin (setupHello), and gives no rows before setupHello ran.
 */
export function helloSettingItems(hello: HelloController | null = currentHello()): SettingDefinitionItem[] {
	if (!hello) return [];
	return [
		{
			type: 'group',
			heading: `More from ${HELLO_BRAND}`,
			items: [
				{
					name: "Show what's new after updates",
					desc: HELLO_TOGGLE_DESC,
					aliases: ['changelog', 'release notes', 'update'],
					render: (setting) => {
						setting.addToggle((t) => t.setValue(hello.enabled).onChange((v) => void hello.setEnabled(v)));
					},
				},
				{
					name: HELLO_BRAND,
					desc: helloAboutText(),
					searchable: false,
					render: (setting) => {
						appendHelloLinks(setting.descEl, hello);
						if (hello.content) setting.addButton((b) => b.setButtonText("Show what's new").onClick(() => void hello.open()));
					},
				},
			],
		},
	];
}

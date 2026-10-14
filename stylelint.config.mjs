// Lints styles.css with the official Obsidian Stylelint rules (no external URLs,
// no named colors, browser support for the Electron that Obsidian ships).
/** @type {import('stylelint').Config} */
export default {
	extends: ['stylelint-config-obsidianmd'],
};

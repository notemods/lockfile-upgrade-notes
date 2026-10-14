import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { globalIgnores, defineConfig } from 'eslint/config';

// Source, manifest.json and package.json all go through eslint-plugin-obsidianmd.
// The lint script runs with --max-warnings 0, so a warning fails the gate too.
export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'.turbo',
		'docs',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'stylelint.config.mjs',
		'versions.json',
		'main.js',
		'package-lock.json',
		'tsconfig.json',
		'tests',
		'vitest.config.ts',
		'wdio.conf.mts',
		'test',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The directory checks the manifest on its own; this mirrors its rules locally:
		// required keys and types, no "obsidian" or "plugin" in id, name or description,
		// description 10-250 characters, capital first letter, final period, plain charset.
		files: ['manifest.json'],
		languageOptions: { parser: tseslint.parser },
		rules: { 'obsidianmd/validate-manifest': 'error' },
	},
);

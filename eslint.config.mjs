import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
	globalIgnores(['luci-reference', 'node_modules', 'docs']),
	/* LuCI client modules: function bodies with a top-level return and
	   loader-injected globals */
	{
		files: ['htdocs/**/*.js'],
		plugins: { js },
		extends: ['js/recommended'],
		languageOptions: {
			sourceType: 'script',
			ecmaVersion: 2023,
			parserOptions: {
				ecmaFeatures: {
					globalReturn: true
				}
			},
			globals: {
				window: 'readonly',
				document: 'readonly',
				navigator: 'readonly',
				location: 'writable',
				URL: 'readonly',
				TextEncoder: 'readonly',
				/* LuCI runtime */
				_: 'readonly',
				N_: 'readonly',
				L: 'readonly',
				E: 'readonly',
				/* modules injected via 'require ...' directives */
				baseclass: 'readonly',
				dom: 'readonly',
				form: 'readonly',
				fs: 'readonly',
				rpc: 'readonly',
				uci: 'readonly',
				ui: 'readonly',
				view: 'readonly',
				grammar: 'readonly'
			}
		},
		rules: {
			'no-unused-vars': ['warn', { caughtErrors: 'none' }],
			/* off in openwrt/luci as well: \xNN ranges are intentional */
			'no-control-regex': 'off'
		}
	},
	{
		files: ['tests/**/*.mjs'],
		plugins: { js },
		extends: ['js/recommended'],
		languageOptions: {
			sourceType: 'module',
			ecmaVersion: 2023,
			globals: {
				process: 'readonly',
				globalThis: 'writable',
				URL: 'readonly'
			}
		}
	}
]);

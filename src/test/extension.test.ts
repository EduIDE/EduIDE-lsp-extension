import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { getLegacySidecarConfig } from '../extension';

const LEGACY_ENV_VARS = [
	'LS_JAVA_HOST', 'LS_JAVA_PORT',
	'LS_RUST_HOST', 'LS_RUST_PORT',
	'LS_HOST', 'LS_PORT'
];

function clearLegacyEnv(): void {
	for (const key of LEGACY_ENV_VARS) {
		delete process.env[key];
	}
}

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	suite('getLegacySidecarConfig legacy LS_PORT parsing', () => {
		teardown(clearLegacyEnv);

		test('accepts a clean numeric port', () => {
			clearLegacyEnv();
			process.env.LS_JAVA_PORT = '8080';
			const entries = getLegacySidecarConfig();
			const java = entries.find(e => e.languages?.includes('java'));
			assert.ok(java, 'expected a java entry');
			assert.strictEqual(java!.port, 8080);
		});

		test('rejects a port string with trailing junk (8080junk)', () => {
			clearLegacyEnv();
			process.env.LS_JAVA_PORT = '8080junk';
			const entries = getLegacySidecarConfig();
			const java = entries.find(e => e.languages?.includes('java'));
			assert.ok(java, 'expected a java entry');
			// A malformed value must not silently become a valid port.
			assert.ok(Number.isNaN(java!.port), 'expected NaN for malformed port');
		});
	});
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('npm package contains the adapter entry point, metadata, admin config and logo', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
    const [pack] = JSON.parse(output);
    const files = new Set(pack.files.map(file => file.path));
    for (const path of ['main.js', 'io-package.json', 'admin/jsonConfig.json', 'admin/lifx_logo.png']) {
        assert.ok(files.has(path), `npm package is missing ${path}`);
    }
});

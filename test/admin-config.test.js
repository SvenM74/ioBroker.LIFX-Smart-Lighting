'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const adminConfig = require('../admin/jsonConfig.json');
const adapterConfig = require('../io-package.json').native;

test('Admin settings are grouped into documented tabs', () => {
    assert.equal(adminConfig.type, 'tabs');
    assert.deepEqual(Object.keys(adminConfig.items), ['devices', 'cloud', 'effects', 'multizone', 'matrix']);
    for (const [tabId, tab] of Object.entries(adminConfig.items)) {
        const help = Object.values(tab.items).find(item => item.type === 'staticText');
        assert.ok(help, `${tabId} tab needs a function description`);
        assert.ok(help.text.en && help.text.de, `${tabId} tab description needs English and German text`);
    }
});

test('Every Admin setting has a matching adapter default', () => {
    const configurationKeys = Object.values(adminConfig.items)
        .flatMap(tab => Object.keys(tab.items))
        .filter(key => !key.startsWith('_'));
    for (const key of configurationKeys) {
        assert.ok(Object.hasOwn(adapterConfig, key), `${key} is missing from io-package.json defaults`);
    }
});

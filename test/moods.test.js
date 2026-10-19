'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MOODS, colorForZone, normalizeMoodPresets, paletteColorForDevice } = require('../lib/moods');

test('default moods contain valid named palettes', () => {
    const presets = normalizeMoodPresets(DEFAULT_MOODS);
    assert.equal(presets.length, 5);
    assert.ok(presets.every(preset => preset.colors.length >= 2));
});

test('custom moods reject duplicate IDs and malformed colors', () => {
    const presets = normalizeMoodPresets([
        { id: 'custom', name: 'Custom', colors: '#ff0000,#00ff00' },
        { id: 'custom', name: 'Duplicate', colors: '#ffffff' },
        { id: 'bad', name: 'Bad', colors: 'red,#abc' },
        { id: 'none', name: 'Reserved', colors: '#ffffff' },
    ]);
    assert.equal(presets.length, 1);
    assert.equal(presets[0].colors.length, 2);
});

test('zones interpolate evenly across a palette and single lights choose deterministically', () => {
    const palette = normalizeMoodPresets([{ id: 'test', name: 'Test', colors: '#ff0000,#0000ff' }])[0].colors;
    assert.deepEqual(colorForZone(palette, 0, 3), palette[0]);
    assert.deepEqual(colorForZone(palette, 2, 3), palette[1]);
    assert.deepEqual(paletteColorForDevice(palette, 'lamp-a'), paletteColorForDevice(palette, 'lamp-a'));
});

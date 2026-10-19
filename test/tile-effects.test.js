'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSetTileEffectPacket, EFFECT_TYPES } = require('../lib/tile-effects');

const base = {
    target: 'd073d55246b9',
    source: '4c465831',
    sequence: 9,
    effect: 'morph',
    speed: 1500,
    instanceid: 0x12345678,
    palette: [{ hue: 180, saturation: 100, brightness: 100, kelvin: 3500 }],
};

test('SetTileEffect packet has the expected header and complete 16-color payload', () => {
    const packet = createSetTileEffectPacket(base);
    assert.equal(packet.length, 224);
    assert.equal(packet.readUInt16LE(0), 224);
    assert.equal(packet.readUInt16LE(2), 0x1400);
    assert.equal(packet.subarray(8, 14).toString('hex'), base.target);
    assert.equal(packet.readUInt8(23), 9);
    assert.equal(packet.readUInt16LE(32), 719);
    assert.equal(packet.readUInt8(42), EFFECT_TYPES.morph);
    assert.equal(packet.readUInt32LE(38), 0x12345678);
    assert.equal(packet.readUInt32LE(43), 1500);
    assert.equal(packet.readUInt8(95), 1);
    assert.equal(packet.readUInt16LE(96), 32768);
    assert.equal(packet.readUInt16LE(98), 65535);
});

test('SetTileEffect supports the documented matrix effect types and validates input', () => {
    assert.deepEqual(EFFECT_TYPES, { off: 0, morph: 2, flame: 3, sky: 5 });
    assert.equal(createSetTileEffectPacket({ ...base, effect: 'off', palette: [] }).readUInt8(42), 0);
    assert.equal(createSetTileEffectPacket({ ...base, effect: 'flame', palette: [] }).readUInt8(42), 3);
    assert.equal(createSetTileEffectPacket({ ...base, effect: 'sky', skyType: 2, palette: [] }).readUInt8(63), 2);
    assert.throws(() => createSetTileEffectPacket({ ...base, target: 'invalid' }), /12-character hexadecimal/);
    assert.throws(() => createSetTileEffectPacket({ ...base, effect: 'unknown' }), /Unsupported Tile Effect/);
    assert.throws(() => createSetTileEffectPacket({ ...base, speed: 1 }), /speed must be between/);
});

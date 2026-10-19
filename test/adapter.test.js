'use strict';

const { EventEmitter } = require('node:events');
const Module = require('node:module');
const dgram = require('node:dgram');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const lights = new Map();

class FakeClient extends EventEmitter {
    light(id) {
        return lights.get(id);
    }
    lights() {
        return [...lights.values()];
    }
    init() {}
}

class FakeAdapter extends EventEmitter {
    constructor() {
        super();
        this.namespace = 'lifx-smart-lighting.0';
        this.config = {};
        this.objects = new Map();
        this.states = new Map();
        this.log = { debug() {}, info() {}, warn() {}, error() {} };
    }
    async setObjectNotExistsAsync(id, obj) {
        if (!this.objects.has(id)) this.objects.set(id, obj);
    }
    async extendObjectAsync(id, patch) {
        this.objects.set(id, { ...this.objects.get(id), ...patch });
    }
    async getObjectAsync(id) {
        return this.objects.get(id) || null;
    }
    async setStateAsync(id, state) {
        this.states.set(id, state);
    }
    async getStateAsync(id) {
        return this.states.get(id) || null;
    }
    subscribeStates() {}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@iobroker/adapter-core') return { Adapter: FakeAdapter };
    if (request === 'lifx-lan-client') return { Client: FakeClient };
    return originalLoad.call(this, request, parent, isMain);
};
const startAdapter = require('../main');
Module._load = originalLoad;

test('adapter creates an explicit rename command while keeping reported label read-only', async () => {
    const adapter = startAdapter();
    await adapter.createBasic('testbulb', 'Test bulb', 2500, 9000);
    assert.equal(adapter.objects.get('Bulb_testbulb.label').common.write, false);
    assert.equal(adapter.objects.get('Bulb_testbulb.rename').common.write, true);
    assert.equal(adapter.objects.get('Bulb_testbulb.rename').common.type, 'string');
    assert.deepEqual(adapter.states.get('Bulb_testbulb.label'), { val: 'Test bulb', ack: true });
    assert.deepEqual(adapter.states.get('Bulb_testbulb.rename'), { val: 'Test bulb', ack: true });
});

test('infrared command uses maxIR and acknowledges the applied percentage', async () => {
    let applied;
    lights.set('irbulb', {
        maxIR(value, callback) {
            applied = value;
            callback(null);
        },
    });
    const adapter = startAdapter();
    await adapter.executeInfrared('irbulb', 42);
    assert.equal(applied, 42);
    assert.deepEqual(adapter.states.get('Bulb_irbulb.infraredBrightness'), { val: 42, ack: true });
    await assert.rejects(adapter.executeInfrared('irbulb', 101), /zwischen 0 und 100/);
});

test('rename command calls the device and updates the label and channel name', async () => {
    let applied;
    lights.set('renameme', {
        setLabel(value, callback) {
            applied = value;
            callback(null);
        },
    });
    const adapter = startAdapter();
    await adapter.renameLight('renameme', 'Hallway');
    assert.equal(applied, 'Hallway');
    assert.deepEqual(adapter.states.get('Bulb_renameme.label'), { val: 'Hallway', ack: true });
    assert.deepEqual(adapter.states.get('Bulb_renameme.rename'), { val: 'Hallway', ack: true });
    assert.equal(adapter.objects.get('Bulb_renameme').common.name, 'LIFX Hallway');
    await assert.rejects(adapter.renameLight('renameme', 'ä'.repeat(17)), /32 UTF-8-Bytes/);
});

test('mood command applies configured color and acknowledges its preset', async () => {
    let colorApplied;
    lights.set('moodbulb', {
        on(_duration, callback) { callback(null); },
        color(hue, saturation, brightness, kelvin, duration, callback) {
            colorApplied = { hue, saturation, brightness, kelvin, duration };
            callback(null);
        },
    });
    const adapter = startAdapter();
    await adapter.createBasic('moodbulb', 'Mood bulb', 2500, 9000);
    await adapter.createMood('moodbulb');
    await adapter.executeMood('moodbulb', 'sunset');
    assert.equal(colorApplied.duration, 1500);
    assert.ok(colorApplied.hue >= 0 && colorApplied.hue < 360);
    assert.equal(adapter.states.get('Bulb_moodbulb.mood').val, 'sunset');
    assert.equal(adapter.states.get('Bulb_moodbulb.colormode').val, 'color');
    lights.delete('moodbulb');
});

test('group mood applies a palette to local members', async () => {
    const calls = [];
    lights.set('groupbulb', {
        id: 'groupbulb',
        on(_duration, callback) { callback(null); },
        color(hue, saturation, brightness, kelvin, duration, callback) {
            calls.push({ hue, saturation, brightness, kelvin, duration });
            callback(null);
        },
    });
    const adapter = startAdapter();
    adapter.states.set('Bulb_groupbulb.groupId', { val: 'lifx-group-1', ack: true });
    adapter.states.set('Bulb_groupbulb.colorLamp', { val: true, ack: true });
    adapter.objects.set('Groups.group_1', { native: { lifxId: 'lifx-group-1' } });
    await adapter.executeCollectionMood('Groups.group_1.mood', 'ocean');
    assert.equal(calls.length, 1);
    assert.equal(adapter.states.get('Bulb_groupbulb.mood').val, 'ocean');
    lights.delete('groupbulb');
});

test('mood palette blends across multizone strip zones', async () => {
    const colors = [];
    lights.set('stripbulb', {
        on(_duration, callback) { callback(null); },
        getColorZones(_start, _end, callback) { callback(null, { count: 3 }); },
        colorZones(_start, _end, hue, saturation, brightness, kelvin, _duration, _apply, callback) {
            colors.push({ hue, saturation, brightness, kelvin });
            callback(null);
        },
    });
    const adapter = startAdapter();
    adapter.states.set('Bulb_stripbulb.multizoneLamp', { val: true, ack: true });
    await adapter.executeMood('stripbulb', 'sunset');
    assert.equal(colors.length, 3);
    assert.notEqual(colors[0].hue, colors[2].hue);
    assert.ok(adapter.objects.has('Bulb_stripbulb.zone_2.hue'));
    lights.delete('stripbulb');
});

test('matrix effect command sends a Tile packet and acknowledges the selected effect', async () => {
    const server = dgram.createSocket('udp4');
    await new Promise(resolve => server.bind(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const packetReceived = new Promise(resolve => server.once('message', resolve));
    const id = 'd073d55246b9';
    lights.set(id, { id, address: '127.0.0.1', port });
    const adapter = startAdapter();
    adapter.states.set(`Bulb_${id}.matrixLamp`, { val: true, ack: true });
    adapter.states.set(`Bulb_${id}.product`, { val: 'LIFX Tile', ack: true });

    try {
        await adapter.executeTileEffect(id, 'morph');
        const packet = await packetReceived;
        assert.equal(packet.readUInt16LE(32), 719);
        assert.equal(packet.readUInt8(42), 2);
        assert.deepEqual(adapter.states.get(`Bulb_${id}.tileEffect`), { val: 'morph', ack: true });
    } finally {
        server.close();
        lights.delete(id);
    }
});

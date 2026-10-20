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
    async delObjectAsync(id) {
        for (const key of this.objects.keys()) if (key === id || key.startsWith(`${id}.`)) this.objects.delete(key);
        for (const key of this.states.keys()) if (key === id || key.startsWith(`${id}.`)) this.states.delete(key);
    }
    subscribeStates() {}
}

class FakeDeviceManagement {
    constructor(adapter) {
        this.adapter = adapter;
    }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@iobroker/adapter-core') return { Adapter: FakeAdapter };
    if (request === '@iobroker/dm-utils') return { DeviceManagement: FakeDeviceManagement };
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

test('device manager exposes discovered lamps with usable controls and rename action', async () => {
    const adapter = startAdapter();
    const id = 'managerbulb';
    let deviceLabel;
    lights.set(id, {
        id,
        setLabel(value, callback) { deviceLabel = value; callback(null); },
        on(_duration, callback) { callback(null); },
        off(_duration, callback) { callback(null); },
        color(_hue, _sat, _bright, _kelvin, _duration, callback) { callback(null); },
    });
    await adapter.createBasic(id, 'Manager bulb', 2500, 9000);
    await adapter.setObjectNotExistsAsync(`Bulb_${id}.vendor`, { type: 'state' });
    await adapter.setObjectNotExistsAsync(`Bulb_${id}.product`, { type: 'state' });
    await adapter.setObjectNotExistsAsync(`Bulb_${id}.colorLamp`, { type: 'state' });
    await adapter.setStateAsync(`Bulb_${id}.colorLamp`, { val: true, ack: true });

    const devices = [];
    let total;
    await adapter.deviceManagement.loadDevices({
        setTotalDevices(count) { total = count; },
        addDevice(device) { devices.push(device); },
    });

    assert.equal(total, 1);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name.stateId, `Bulb_${id}.label`);
    assert.equal(devices[0].status.connection.stateId, `Bulb_${id}.online`);
    assert.deepEqual(devices[0].controls.map(control => control.stateId), [
        `Bulb_${id}.state`, `Bulb_${id}.bright`, `Bulb_${id}.temp`, `Bulb_${id}.hue`, `Bulb_${id}.sat`,
    ]);
    assert.deepEqual(devices[0].actions.map(action => action.id), ['configure', 'refresh', 'rename']);
    assert.equal(devices[0].hasDetails, true);
    let submittedForm;
    const actionResult = await devices[0].actions.find(action => action.id === 'configure').handler(id, {
        async showForm(schema, options) {
            submittedForm = { schema, options };
            return { power: true, brightness: 48, color: '#336699' };
        },
    });
    assert.equal(actionResult.refresh, 'all');
    assert.ok(submittedForm.schema.items.color);
    assert.equal(submittedForm.options.data.brightness, 0);
    assert.equal(adapter.states.get(`Bulb_${id}.bright`).val, 48);
    const renameResult = await devices[0].actions.find(action => action.id === 'rename').handler(id, {
        async showForm() { return { label: 'Configured in Admin' }; },
    });
    assert.equal(renameResult.refresh, 'all');
    assert.equal(deviceLabel, 'Configured in Admin');
    assert.equal(adapter.states.get(`Bulb_${id}.label`).val, 'Configured in Admin');
    lights.delete(id);
});

test('Device Manager configuration applies power, brightness and selected color', async () => {
    const applied = {};
    lights.set('configbulb', {
        on(duration, callback) { applied.power = ['on', duration]; callback(null); },
        off(duration, callback) { applied.power = ['off', duration]; callback(null); },
        color(hue, saturation, brightness, kelvin, duration, callback) {
            Object.assign(applied, { hue, saturation, brightness, kelvin, duration });
            callback(null);
        },
    });
    const adapter = startAdapter();
    await adapter.createBasic('configbulb', 'Config bulb', 2500, 9000);
    await adapter.createColor('configbulb');
    await adapter.setStateAsync('Bulb_configbulb.colorLamp', { val: true, ack: true });
    await adapter.setStateAsync('Bulb_configbulb.temp', { val: 4000, ack: true });
    await adapter.configureLight('configbulb', { power: true, brightness: 65, color: '#00ff00' });
    assert.deepEqual(applied, { power: ['on', 500], hue: 120, saturation: 100, brightness: 65, kelvin: 4000, duration: 500 });
    assert.equal(adapter.states.get('Bulb_configbulb.state').val, true);
    assert.equal(adapter.states.get('Bulb_configbulb.bright').val, 65);
    assert.equal(adapter.states.get('Bulb_configbulb.colormode').val, 'color');
    lights.delete('configbulb');
});

test('Device Manager refresh deletes stale lamp data points and recreates discovered ones', async () => {
    const id = 'refreshbulb';
    lights.set(id, {
        id,
        getHardwareVersion(callback) {
            callback(null, { vendorName: 'LIFX', productName: 'Color bulb', version: '1', productFeatures: { color: false, temperature_range: [2500, 9000] } });
        },
        getState(callback) {
            callback(null, { label: 'Refreshed lamp', power: 1, color: { brightness: 70, kelvin: 3500 } });
        },
    });
    const adapter = startAdapter();
    await adapter.createBasic(id, 'Old lamp', 2500, 9000);
    await adapter.setObjectNotExistsAsync(`Bulb_${id}.stale`, { type: 'state' });
    await adapter.setStateAsync(`Bulb_${id}.stale`, { val: 'remove', ack: true });
    await adapter.refreshLightObjects(id);
    assert.equal(await adapter.getObjectAsync(`Bulb_${id}.stale`), null);
    assert.equal((await adapter.getObjectAsync(`Bulb_${id}.bright`)).common.write, true);
    assert.equal(adapter.states.get(`Bulb_${id}.label`).val, 'Refreshed lamp');
    assert.equal(adapter.states.get(`Bulb_${id}.state`).val, true);
    lights.delete(id);
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

test('group brightness control uses a stable Cloud group selector', async () => {
    const adapter = startAdapter();
    let request;
    adapter.config.collectionTransition = 2;
    adapter.cloudRequest = async (...args) => { request = args; };
    adapter.objects.set('Groups.grp', { native: { lifxId: 'group-123' } });
    assert.equal(await adapter.executeCloudCommand('Groups.grp.brightness', { val: 40 }), true);
    assert.deepEqual(request, ['/lights/group_id%3Agroup-123/state', 'PUT', { brightness: 0.4, duration: 2 }]);
});

test('local scene can be captured, activated and removed', async () => {
    const calls = [];
    lights.set('sceneBulb', {
        id: 'sceneBulb',
        on(duration, callback) { calls.push(['on', duration]); callback(null); },
        off(duration, callback) { calls.push(['off', duration]); callback(null); },
        color(h, s, b, k, duration, callback) { calls.push(['color', h, s, b, k, duration]); callback(null); },
    });
    const adapter = startAdapter();
    adapter.states.set('Bulb_sceneBulb.state', { val: true, ack: true });
    adapter.states.set('Bulb_sceneBulb.bright', { val: 75, ack: true });
    adapter.states.set('Bulb_sceneBulb.hue', { val: 45, ack: true });
    adapter.states.set('Bulb_sceneBulb.sat', { val: 80, ack: true });
    adapter.states.set('Bulb_sceneBulb.temp', { val: 3200, ack: true });
    try {
        await adapter.executeCloudCommand('Scenes.Local.newName', { val: 'Abendlicht' });
        const scene = adapter.objects.get('Scenes.Local.Abendlicht');
        assert.ok(scene.native.snapshot.some(light => light.id === 'sceneBulb'));
        await adapter.executeCloudCommand('Scenes.Local.Abendlicht.activate', { val: true });
        assert.deepEqual(calls[0], ['on', 1500]);
        assert.deepEqual(calls[1], ['color', 45, 80, 75, 3200, 1500]);
        await adapter.executeCloudCommand('Scenes.Local.Abendlicht.delete', { val: true });
        assert.equal(adapter.objects.has('Scenes.Local.Abendlicht'), false);
    } finally {
        lights.delete('sceneBulb');
    }
});

test('zone power writes only the selected color zone and restores its saved brightness', async () => {
    const calls = [];
    lights.set('zonebulb', {
        colorZones(start, end, hue, sat, brightness, kelvin, duration, apply, callback) {
            calls.push({ start, end, hue, sat, brightness, kelvin, duration, apply });
            callback(null);
        },
    });
    const adapter = startAdapter();
    adapter.states.set('Bulb_zonebulb.zone_2.hue', { val: 120, ack: true });
    adapter.states.set('Bulb_zonebulb.zone_2.sat', { val: 100, ack: true });
    adapter.states.set('Bulb_zonebulb.zone_2.bright', { val: 62, ack: true });
    adapter.states.set('Bulb_zonebulb.zone_2.temp', { val: 3500, ack: true });
    try {
        await adapter.executeZonePower('zonebulb', 2, false);
        await adapter.executeZonePower('zonebulb', 2, true);
        assert.equal(calls[0].brightness, 0);
        assert.equal(calls[1].brightness, 62);
        assert.equal(calls[0].start, 2);
        assert.equal(adapter.states.get('Bulb_zonebulb.zone_2.zonePower').val, true);
    } finally {
        lights.delete('zonebulb');
    }
});

'use strict';

const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const lights = new Map();

class FakeClient extends EventEmitter {
    light(id) {
        return lights.get(id);
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

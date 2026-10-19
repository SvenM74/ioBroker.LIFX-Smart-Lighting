'use strict';

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');

// Load your modules here, e.g.:
// const fs = require("node:fs");
const LifxClient = require('lifx-lan-client').Client;
const tileEffects = require('./lib/tile-effects');
const moods = require('./lib/moods');
const routines = require('./lib/routines');
const client = new LifxClient();
let lifxTimeout;
let diagnosticsTimeout;
let cloudTimeout;
const effectRuns = new Map();
const moveEffects = new Map();
const runningTileEffects = new Map();
const tileEffectInstances = new Map();
const tileSequences = new Map();

class Lifx extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - options
     */
    constructor(options) {
        super({
            ...options,
            name: 'lifx-smart-lighting',
        });
        this.stopping = false;
        this.lastRoutineRuns = new Map();
        this.zoneBrightness = new Map();
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        client.on('light-new', light => {
            this.handleNewLight(light).catch(error => this.handleLightError(light, 'initialization', error));
        });

        client.on('light-online', light => {
            this.handleLightOnline(light).catch(error => this.handleLightError(light, 'reconnection', error));
        });

        client.on('light-offline', light => {
            this.handleLightOffline(light).catch(error => this.handleLightError(light, 'offline update', error));
        });

        client.on('error', error => {
            this.log.error('LIFX client error: ' + (error?.message || error));
        });

        client.on('listening', () => {
            const address = client.address();
            this.log.info(`Started LIFX listening on ${address.address}:${address.port}\n`);
        });
        client.init({ debug: true }, () => {
            this.log.info('Client started');
        });

        lifxTimeout = setTimeout(() => this.pollLifxData(), 5000);

        await this.ensureCloudStatusObjects();
        await this.ensureLocalSceneObjects();
        this.scheduleDiagnostics(10000);
        if (this.config.cloudEnabled && this.config.cloudToken) {
            this.scheduleCloudSync(10000);
            this.scheduleRoutines(15000);
        } else {
            await this.setStateAsync('info.cloudConnected', { val: false, ack: true });
        }

        this.subscribeStates('*');
    }

    requestLightData(light, method, ...args) {
        return new Promise((resolve, reject) => {
            const request = light?.[method];
            if (typeof request !== 'function') {
                reject(new Error(`LIFX device does not support ${method}`));
                return;
            }
            let settled = false;
            const callback = (error, result) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve(result);
            };
            try {
                request.call(light, ...args, callback);
            } catch (error) {
                reject(error);
            }
        });
    }

    async handleLightError(light, action, error) {
        const id = light?.id;
        this.log.warn(`LIFX ${action} failed${id ? ` for ${id}` : ''}: ${error?.message || error}`);
        if (!id) return;
        try {
            if (!(await this.getObjectAsync(`Bulb_${id}.online`))) {
                await this.createBasic(id, `LIFX ${id}`, 1500, 9000);
            }
            await this.stopEffect(id, false);
            await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
            await this.setStateAsync(`Bulb_${id}.online`, { val: false, ack: true });
        } catch (stateError) {
            this.log.error(`Could not update connection state for ${id}: ${stateError?.message || stateError}`);
        }
    }

    async handleNewLight(light) {
        await this.createBasic(light.id, light.label || `LIFX ${light.id}`, 1500, 9000);
        this.log.info(`Discovered LIFX light ${light.id} at ${light.address}:${light.port}`);

        const info = await this.requestLightData(light, 'getHardwareVersion');
        const state = await this.requestLightData(light, 'getState');
        const features = info?.productFeatures || {};
        const range = features.temperature_range || [1500, 9000];
        const productName = info?.productName || '';
        const matrixCapable = features.matrix === true || features.matrixZones === true || /\b(tile|tiles|candle|ceiling)\b/i.test(productName);
        await this.createBasic(light.id, state?.label || `LIFX ${light.id}`, range[0], range[1]);
        await this.setStateAsync(`Bulb_${light.id}.matrixLamp`, { val: matrixCapable, ack: true });
        if (matrixCapable) {
            await this.createTileEffect(light.id);
        }

        for (const [stateId, value] of [
            ['vendor', info.vendorName || ''],
            ['product', info.productName || ''],
            ['version', String(info.version ?? '')],
            ['colorLamp', features.color === true],
            ['infraredLamp', features.infrared === true],
            ['multizoneLamp', features.multizone === true],
            ['label', state?.label || ''],
            ['rename', state?.label || ''],
            ['state', state?.power === 1],
            ['bright', state?.color?.brightness ?? 0],
            ['temp', state?.color?.kelvin ?? range[0]],
            ['online', true],
            ['lastSeen', Date.now()],
        ]) {
            await this.setStateAsync(`Bulb_${light.id}.${stateId}`, { val: value, ack: true });
        }

        if (matrixCapable) {
            const savedTileEffect = await this.getStateAsync(`Bulb_${light.id}.tileEffect`);
            if (savedTileEffect?.val && savedTileEffect.val !== 'off') {
                try {
                    await this.executeTileEffect(light.id, String(savedTileEffect.val));
                } catch (error) {
                    this.log.warn(`Could not restore matrix effect for ${light.id}: ${error.message || error}`);
                }
            }
        }

        if (features.infrared === true) {
            await this.createInfrared(light.id);
            try {
                const infrared = await this.requestLightData(light, 'getMaxIR');
                if (infrared && Number.isFinite(Number(infrared.brightness))) {
                    await this.setStateAsync(`Bulb_${light.id}.infraredBrightness`, {
                        val: Number(infrared.brightness),
                        ack: true,
                    });
                }
            } catch (error) {
                this.log.debug(`Could not read infrared brightness for ${light.id}: ${error.message || error}`);
            }
        }

        if (features.color === true) {
            await this.createColor(light.id);
            await this.setStateAsync(`Bulb_${light.id}.hue`, { val: state?.color?.hue ?? 0, ack: true });
            await this.setStateAsync(`Bulb_${light.id}.sat`, { val: state?.color?.saturation ?? 0, ack: true });
            await this.setStateAsync(`Bulb_${light.id}.colormode`, {
                val: (state?.color?.saturation ?? 0) > 0 ? 'color' : 'white',
                ack: true,
            });
        }
        if (this.config.moodsEnabled !== false && (features.color === true || features.multizone === true)) {
            await this.createMood(light.id);
        }
        if (this.config.cloudEnabled && this.config.cloudToken) await this.createCloudEffect(light.id);

        if (features.multizone === true) {
            await this.createZoneEffect(light.id);
            try {
                const infoZones = await this.requestLightData(light, 'getColorZones', 0, 255);
                const count = Math.max(0, Number(infoZones?.count) || 0);
                for (let offset = 0; offset < count; offset += 8) {
                    const result = await this.requestLightData(
                        light,
                        'getColorZones',
                        offset,
                        Math.min(offset + 7, count - 1),
                    );
                    for (let index = 0; index < (result?.color?.length || 0); index++) {
                        const reportedIndex = Number(result.index);
                        const zone = (Number.isFinite(reportedIndex) ? reportedIndex : offset) + index;
                        await this.createZone(light.id, zone);
                        const color = result.color[index];
                        for (const [key, value] of [
                            ['hue', color.hue],
                            ['sat', color.saturation],
                            ['bright', color.brightness],
                            ['temp', color.kelvin],
                        ]) {
                            await this.setStateAsync(`Bulb_${light.id}.zone_${zone}.${key}`, { val: value, ack: true });
                        }
                        this.zoneBrightness.set(`${light.id}:${zone}`, Number(color.brightness) || 0);
                        await this.setStateAsync(`Bulb_${light.id}.zone_${zone}.zonePower`, {
                            val: Number(color.brightness) > 0, ack: true,
                        });
                    }
                }
            } catch (error) {
                this.log.debug(`Could not initialize zones for ${light.id}: ${error.message || error}`);
            }
            const savedZoneEffect = await this.getStateAsync(`Bulb_${light.id}.zoneEffect`);
            const desiredEffect = moveEffects.get(light.id) || savedZoneEffect?.val;
            if (desiredEffect === 'move' || (moveEffects.has(light.id) && desiredEffect === 'off')) {
                await this.executeZoneEffect(light.id, desiredEffect);
            }
        }
    }

    async handleLightOnline(light) {
        await this.handleNewLight(light);
        this.log.info(`LIFX light ${light.id} reconnected`);
    }

    async handleLightOffline(light) {
        if (!(await this.getObjectAsync(`Bulb_${light.id}.online`))) {
            await this.createBasic(light.id, `LIFX ${light.id}`, 1500, 9000);
        }
        await this.stopEffect(light.id, false);
        runningTileEffects.delete(light.id);
        tileEffectInstances.delete(light.id);
        if (await this.getObjectAsync(`Bulb_${light.id}.tileEffect`)) {
            await this.setStateAsync(`Bulb_${light.id}.tileEffect`, { val: 'off', ack: true });
        }
        await this.setStateAsync(`Bulb_${light.id}.effect`, { val: 'off', ack: true });
        await this.setStateAsync(`Bulb_${light.id}.online`, { val: false, ack: true });
        this.log.info(`LIFX light ${light.id} is offline`);
    }

    async createZoneEffect(id) {
        await this.setObjectNotExistsAsync(`Bulb_${id}.zoneEffect`, {
            type: 'state',
            common: {
                name: 'Zoneneffekt',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states: { off: 'Aus', move: 'Move' },
            },
            native: {},
        });
        const state = await this.getStateAsync(`Bulb_${id}.zoneEffect`);
        if (state == null || state.val == null) {
            await this.setStateAsync(`Bulb_${id}.zoneEffect`, { val: 'off', ack: true });
        }
    }

    async createInfrared(id) {
        await this.setObjectNotExistsAsync(`Bulb_${id}.infraredBrightness`, {
            type: 'state',
            common: {
                name: 'Infrarot-Helligkeit',
                type: 'number',
                role: 'level.dimmer',
                read: true,
                write: true,
                min: 0,
                max: 100,
                unit: '%',
            },
            native: {},
        });
    }

    async createTileEffect(id) {
        await this.setObjectNotExistsAsync(`Bulb_${id}.tileEffect`, {
            type: 'state',
            common: {
                name: 'Matrix-Lichteffekt',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states: { off: 'Aus', morph: 'Morph', flame: 'Flamme', sky: 'Himmel' },
                desc: 'Firmwareeffekt für Matrixgeräte wie Tile, Candle und Ceiling',
            },
            native: {},
        });
        const state = await this.getStateAsync(`Bulb_${id}.tileEffect`);
        if (state == null || state.val == null) {
            await this.setStateAsync(`Bulb_${id}.tileEffect`, { val: 'off', ack: true });
        }
    }

    async createCloudEffect(id) {
        const values = {
            off: 'Aus', clouds: 'Wolken', sunrise: 'Sonnenaufgang', sunset: 'Sonnenuntergang',
            morph: 'Morph', flame: 'Flamme', move: 'Move', clean: 'Reinigung',
        };
        await this.setObjectNotExistsAsync(`Bulb_${id}.cloudEffect`, {
            type: 'state',
            common: {
                name: 'LIFX Cloud-Effekt', type: 'string', role: 'text', read: true, write: true,
                states: values,
                desc: 'Firmwareeffekt über die offizielle LIFX Cloud API; benötigt Cloud-Token und kompatible Lampe',
            },
            native: {},
        });
        const state = await this.getStateAsync(`Bulb_${id}.cloudEffect`);
        if (!state || state.val == null) await this.setStateAsync(`Bulb_${id}.cloudEffect`, { val: 'off', ack: true });
    }

    async createMood(id) {
        const presets = moods.normalizeMoodPresets(this.config.moodPresets);
        const states = { none: 'Keine Stimmung' };
        for (const preset of presets) states[preset.id] = preset.name;
        await this.setObjectNotExistsAsync(`Bulb_${id}.mood`, {
            type: 'state',
            common: {
                name: 'Stimmung',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states,
                desc: 'Wendet eine konfigurierbare Farbpalette auf diese Lampe an',
            },
            native: {},
        });
        await this.extendObjectAsync(`Bulb_${id}.mood`, { common: { states } });
        const state = await this.getStateAsync(`Bulb_${id}.mood`);
        if (state == null || !Object.hasOwn(states, String(state.val))) {
            await this.setStateAsync(`Bulb_${id}.mood`, { val: 'none', ack: true });
        }
    }

    async executeMood(id, moodId, paletteIndex) {
        const light = client.light(id);
        if (!light) throw new Error(`LIFX device ${id} is not available`);
        const preset = moods.normalizeMoodPresets(this.config.moodPresets).find(item => item.id === moodId);
        if (!preset) throw new Error(`Unknown mood '${moodId}'`);
        const durationValue = Number(this.config.moodTransitionDuration);
        const duration = Number.isFinite(durationValue) ? Math.min(60000, Math.max(0, durationValue)) : 1500;
        if (typeof light.on === 'function') {
            await new Promise((resolve, reject) => light.on(duration, error => error ? reject(error) : resolve()));
        }
        const zones = await this.getStateAsync(`Bulb_${id}.multizoneLamp`);
        if (zones?.val === true && typeof light.colorZones === 'function') {
            const info = await this.requestLightData(light, 'getColorZones', 0, 255);
            const count = Math.max(0, Math.min(256, Number(info?.count) || 0));
            if (count) {
                for (let zone = 0; zone < count; zone++) {
                    const color = moods.colorForZone(preset.colors, zone, count);
                    await this.createZone(id, zone);
                    await new Promise((resolve, reject) => {
                        light.colorZones(zone, zone, color.hue, color.saturation, color.brightness, color.kelvin, duration, true,
                            error => error ? reject(error) : resolve());
                    });
                    for (const [key, value] of [['hue', color.hue], ['sat', color.saturation], ['bright', color.brightness], ['temp', color.kelvin]]) {
                        await this.setStateAsync(`Bulb_${id}.zone_${zone}.${key}`, { val: value, ack: true });
                    }
                    if (zone + 1 < count) await new Promise(resolve => setTimeout(resolve, 55));
                }
            }
        } else if (typeof light.color === 'function') {
            const color = Number.isInteger(paletteIndex) ? preset.colors[paletteIndex % preset.colors.length] :
                moods.paletteColorForDevice(preset.colors, id);
            await new Promise((resolve, reject) => {
                light.color(color.hue, color.saturation, color.brightness, color.kelvin, duration,
                    error => error ? reject(error) : resolve());
            });
            await this.setStateAsync(`Bulb_${id}.hue`, { val: color.hue, ack: true });
            await this.setStateAsync(`Bulb_${id}.sat`, { val: color.saturation, ack: true });
            await this.setStateAsync(`Bulb_${id}.bright`, { val: color.brightness, ack: true });
            await this.setStateAsync(`Bulb_${id}.temp`, { val: color.kelvin, ack: true });
            await this.setStateAsync(`Bulb_${id}.colormode`, { val: 'color', ack: true });
        } else {
            throw new Error(`LIFX device ${id} does not support color control`);
        }
        await this.setStateAsync(`Bulb_${id}.mood`, { val: moodId, ack: true });
    }

    async executeCollectionMood(relativeId, moodId) {
        const collectionPath = relativeId.slice(0, relativeId.lastIndexOf('.'));
        const object = await this.getObjectAsync(collectionPath);
        const lifxId = object?.native?.lifxId;
        if (!lifxId) throw new Error(`Could not identify collection for ${relativeId}`);
        const isGroup = relativeId.startsWith('Groups.');
        const matching = [];
        for (const light of client.lights('')) {
            const state = await this.getStateAsync(`Bulb_${light.id}.${isGroup ? 'groupId' : 'locationId'}`);
            const color = await this.getStateAsync(`Bulb_${light.id}.colorLamp`);
            const multizone = await this.getStateAsync(`Bulb_${light.id}.multizoneLamp`);
            if (state?.val === lifxId && (color?.val === true || multizone?.val === true)) matching.push(light);
        }
        if (!matching.length) throw new Error(`No local lights found for ${collectionPath}`);
        const normalized = moods.normalizeMoodPresets(this.config.moodPresets);
        const preset = normalized.find(item => item.id === moodId);
        if (!preset) throw new Error(`Unknown mood '${moodId}'`);
        const results = await Promise.allSettled(
            matching.map((light, index) => this.executeMood(light.id, moodId, index % preset.colors.length)),
        );
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) throw new Error(`${failures.length} von ${matching.length} Lampen konnten nicht geändert werden`);
    }

    nextTileSequence(id) {
        const next = ((tileSequences.get(id) || 0) + 1) & 0xff;
        tileSequences.set(id, next);
        return next;
    }

    async executeTileEffect(id, effect) {
        if (!Object.hasOwn(tileEffects.EFFECT_TYPES, effect)) {
            throw new Error(`Unsupported matrix effect '${effect}'`);
        }
        const light = client.light(id);
        if (!light) throw new Error(`LIFX device ${id} is not available`);
        const capability = await this.getStateAsync(`Bulb_${id}.matrixLamp`);
        if (effect !== 'off' && capability?.val !== true) {
            throw new Error(`LIFX device ${id} does not support Matrix Zones`);
        }
        const product = await this.getStateAsync(`Bulb_${id}.product`);
        if (effect === 'sky') {
            if (!/ceiling/i.test(String(product?.val || ''))) {
                throw new Error('Der Sky-Effekt wird nur von LIFX Ceiling unterstützt');
            }
            const firmware = await this.requestLightData(light, 'getFirmwareVersion');
            const isNewEnough = Number(firmware?.majorVersion) > 4 ||
                (Number(firmware?.majorVersion) === 4 && Number(firmware?.minorVersion) >= 4);
            if (!isNewEnough) throw new Error('Der Sky-Effekt benötigt LIFX Ceiling Firmware 4.4 oder neuer');
        }

        const configNumber = (key, fallback, min, max) => {
            const value = Number(this.config[key]);
            return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
        };
        const speed = configNumber('tileEffectSpeed', 1500, 100, 60000);
        const morphPalette = [
            configNumber('tileMorphHue1', 190, 0, 360),
            configNumber('tileMorphHue2', 285, 0, 360),
            configNumber('tileMorphHue3', 25, 0, 360),
        ].map(hue => ({ hue, saturation: 100, brightness: 100, kelvin: 3500 }));
        const skyPalette = [
            { hue: 205, saturation: 70, brightness: 35, kelvin: 6500 },
            { hue: 220, saturation: 80, brightness: 8, kelvin: 6500 },
            { hue: 270, saturation: 75, brightness: 40, kelvin: 5000 },
            { hue: 25, saturation: 90, brightness: 90, kelvin: 3000 },
            { hue: 45, saturation: 80, brightness: 100, kelvin: 3500 },
            { hue: 15, saturation: 90, brightness: 75, kelvin: 2700 },
        ];
        const skyTypeSetting = this.config.tileSkyType;
        const skyType = Number.isInteger(Number(skyTypeSetting)) ? Number(skyTypeSetting) : 0;
        const source = /^[0-9a-f]{8}$/i.test(client.source || '') ? client.source : '4c465831';
        let instanceid = tileEffectInstances.get(id);
        if (effect !== 'off' && (!instanceid || runningTileEffects.get(id) !== effect)) {
            instanceid = crypto.randomBytes(4).readUInt32LE(0);
        }
        if (instanceid === undefined) instanceid = crypto.randomBytes(4).readUInt32LE(0);
        await tileEffects.sendTileEffect(light, {
            source,
            sequence: this.nextTileSequence(id),
            effect,
            instanceid,
            speed,
            skyType,
            palette: effect === 'morph' ? morphPalette : effect === 'sky' ? skyPalette : [],
        });
        if (effect === 'off') {
            runningTileEffects.delete(id);
            tileEffectInstances.delete(id);
        } else {
            runningTileEffects.set(id, effect);
            tileEffectInstances.set(id, instanceid);
        }
        await this.setStateAsync(`Bulb_${id}.tileEffect`, { val: effect, ack: true });
    }

    async executeInfrared(id, brightness) {
        const value = Number(brightness);
        const light = client.light(id);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
            throw new Error('Infrarot-Helligkeit muss zwischen 0 und 100 liegen');
        }
        if (!light || typeof light.maxIR !== 'function') {
            throw new Error(`LIFX light ${id} does not support infrared control`);
        }
        await new Promise((resolve, reject) => {
            light.maxIR(value, error => error ? reject(error) : resolve());
        });
        await this.setStateAsync(`Bulb_${id}.infraredBrightness`, { val: value, ack: true });
    }

    async renameLight(id, label) {
        const value = String(label ?? '').trim();
        const light = client.light(id);
        if (!value) throw new Error('Der Lampenname darf nicht leer sein');
        if (Buffer.byteLength(value, 'utf8') > 32) throw new Error('Der Lampenname darf maximal 32 UTF-8-Bytes lang sein');
        if (!light || typeof light.setLabel !== 'function') {
            throw new Error(`LIFX light ${id} is not available for renaming`);
        }
        await new Promise((resolve, reject) => {
            light.setLabel(value, error => error ? reject(error) : resolve());
        });
        await this.setStateAsync(`Bulb_${id}.label`, { val: value, ack: true });
        await this.setStateAsync(`Bulb_${id}.rename`, { val: value, ack: true });
        await this.extendObjectAsync(`Bulb_${id}`, { common: { name: `LIFX ${value}` } });
    }

    async executeZoneEffect(id, effect) {
        const light = client.light(id);
        const speedValue = Number(this.config.multiZoneMoveSpeed);
        const speed = Number.isFinite(speedValue) ? Math.min(60000, Math.max(100, speedValue)) : 1500;
        const direction = this.config.multiZoneMoveAway === true ? 'AWAY' : 'TOWARDS';

        if (effect !== 'off' && effect !== 'move') {
            this.log.warn(`Unsupported zone effect '${effect}' requested for ${id}`);
            await this.setStateAsync(`Bulb_${id}.zoneEffect`, { val: 'off', ack: true });
            return;
        }
        if (effect === 'move') {
            const supportsMultizone = await this.getStateAsync(`Bulb_${id}.multizoneLamp`);
            if (supportsMultizone?.val !== true || typeof light?.setMultiZoneEffect !== 'function') {
                moveEffects.delete(id);
                this.log.warn(`Move effect is not supported by LIFX device ${id}`);
                await this.setStateAsync(`Bulb_${id}.zoneEffect`, { val: 'off', ack: true });
                return;
            }
        }
        moveEffects.set(id, effect);
        if (!light || typeof light.setMultiZoneEffect !== 'function') {
            await this.setStateAsync(`Bulb_${id}.zoneEffect`, { val: effect, ack: true });
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                light.setMultiZoneEffect(effect === 'move' ? 'MOVE' : 'OFF', speed, direction, error => {
                    if (error) reject(error);
                    else resolve();
                });
            });
            await this.setStateAsync(`Bulb_${id}.zoneEffect`, { val: effect, ack: true });
        } catch (error) {
            this.log.warn(`Could not set zone effect for ${id}: ${error.message || error}`);
            await this.setStateAsync(`Bulb_${id}.zoneEffect`, { val: effect, ack: true });
        }
    }

    async ensureCloudStatusObjects() {
        await this.setObjectNotExistsAsync('info', {
            type: 'channel',
            common: { name: 'Adapter status', role: 'info' },
            native: {},
        });
        for (const [id, name, type, role] of [
            ['cloudConnected', 'Cloud API verbunden', 'boolean', 'indicator.reachable'],
            ['lastCloudSync', 'Letzte Cloud-Synchronisierung', 'number', 'value.time'],
            ['cloudError', 'Letzter Cloud-Fehler', 'string', 'text'],
        ]) {
            await this.setObjectNotExistsAsync(`info.${id}`, {
                type: 'state',
                common: { name, type, role, read: true, write: false },
                native: {},
            });
        }
    }

    scheduleDiagnostics(delay = (Number(this.config.diagnosticsInterval) || 300) * 1000) {
        if (!this.config.diagnosticsEnabled) return;
        diagnosticsTimeout = setTimeout(async () => {
            try {
                for (const light of client.lights('on')) await this.updateDiagnostics(light);
            } catch (error) {
                this.log.debug(`LIFX diagnostics update failed: ${error.message || error}`);
            }
            this.scheduleDiagnostics();
        }, delay);
    }

    async updateDiagnostics(light) {
        const id = `Bulb_${light.id}`;
        if (!(await this.getObjectAsync(`${id}.online`))) {
            await this.createBasic(light.id, `LIFX ${light.id}`, 1500, 9000);
        }
        await this.setStateAsync(`${id}.lastSeen`, { val: Date.now(), ack: true });
        try {
            const wifi = await this.requestLightData(light, 'getWifiInfo');
            if (wifi) {
                for (const [key, val] of [['wifiSignal', wifi.signal], ['wifiTx', wifi.tx], ['wifiRx', wifi.rx]]) {
                    if (Number.isFinite(Number(val))) await this.setStateAsync(`${id}.${key}`, { val: Number(val), ack: true });
                }
            }
        } catch (error) {
            this.log.debug(`Failed getting Wi-Fi diagnostics for ${light.id}: ${error.message || error}`);
        }
        try {
            const version = await this.requestLightData(light, 'getFirmwareVersion');
            if (version) {
                const value = typeof version === 'string' ? version : `${version.majorVersion}.${version.minorVersion}`;
                await this.setStateAsync(`${id}.firmwareVersion`, { val: value, ack: true });
            }
        } catch (error) {
            this.log.debug(`Failed getting firmware version for ${light.id}: ${error.message || error}`);
        }
    }

    scheduleCloudSync(delay = 0) {
        if (!this.config.cloudEnabled || !this.config.cloudToken) return;
        cloudTimeout = setTimeout(async () => {
            try {
                await this.syncCloudData();
                await this.setStateAsync('info.cloudConnected', { val: true, ack: true });
                await this.setStateAsync('info.lastCloudSync', { val: Date.now(), ack: true });
                await this.setStateAsync('info.cloudError', { val: '', ack: true });
            } catch (error) {
                await this.setStateAsync('info.cloudConnected', { val: false, ack: true });
                await this.setStateAsync('info.cloudError', { val: error.message || String(error), ack: true });
                this.log.warn(`LIFX Cloud sync failed: ${error.message || error}`);
            }
            this.scheduleCloudSync((Number(this.config.cloudPollInterval) || 300) * 1000);
        }, delay);
    }

    async cloudRequest(path, method = 'GET', body) {
        const response = await fetch(`https://api.lifx.com/v1${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.config.cloudToken}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`LIFX Cloud returned HTTP ${response.status}`);
        if (response.status === 204 || response.status === 202) return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    async syncCloudData() {
        const lights = await this.cloudRequest('/lights/all');
        if (!Array.isArray(lights)) throw new Error('Unexpected response from LIFX Cloud lights endpoint');
        if (this.config.syncGroups !== false) await this.syncCloudCollections(lights, 'group');
        if (this.config.syncLocations !== false) await this.syncCloudCollections(lights, 'location');
        for (const light of lights) {
            const localId = `Bulb_${light.id}`;
            if (!(await this.getObjectAsync(localId))) continue;
            const groupId = light.group?.id || '';
            const locationId = light.location?.id || '';
            await this.setStateAsync(`${localId}.group`, { val: light.group?.name || '', ack: true });
            await this.setStateAsync(`${localId}.groupId`, { val: groupId, ack: true });
            await this.setStateAsync(`${localId}.location`, { val: light.location?.name || '', ack: true });
            await this.setStateAsync(`${localId}.locationId`, { val: locationId, ack: true });
        }
        if (this.config.syncScenes !== false) {
            const scenes = await this.cloudRequest('/scenes');
            if (Array.isArray(scenes)) await this.syncCloudScenes(scenes);
        }
    }

    async syncCloudCollections(lights, kind) {
        const collectionKey = kind === 'group' ? 'group' : 'location';
        const objectRoot = kind === 'group' ? 'Groups' : 'Locations';
        const collections = new Map();
        for (const light of lights) {
            const collection = light[collectionKey];
            if (!collection?.id) continue;
            const entry = collections.get(collection.id) || { ...collection, members: [], power: 'off' };
            entry.members.push(light.label || light.id);
            if (light.power === 'on') entry.power = 'on';
            collections.set(collection.id, entry);
        }
        for (const [id, collection] of collections) {
            const safeId = encodeURIComponent(id).replace(/%/g, '_');
            const path = `${objectRoot}.${safeId}`;
            await this.setObjectNotExistsAsync(path, {
                type: 'channel',
                common: { name: collection.name || id, role: 'channel' },
                native: { lifxId: id },
            });
            const collectionStates = [
                ['name', 'Name', 'string', 'info.name', false],
                ['members', 'Lampen', 'string', 'json', false],
                ['power', 'Ein/Aus', 'boolean', 'switch', true],
                ['brightness', 'Helligkeit (%)', 'number', 'level.dimmer', true],
                ['color', 'Farbe (#RRGGBB)', 'string', 'text', true],
                ['kelvin', 'Farbtemperatur (Kelvin)', 'number', 'level.color.temp', true],
            ];
            if (this.config.moodsEnabled !== false) collectionStates.push(['mood', 'Stimmung', 'string', 'text', true]);
            const moodStates = { none: 'Keine Stimmung' };
            for (const preset of moods.normalizeMoodPresets(this.config.moodPresets)) moodStates[preset.id] = preset.name;
            for (const [stateId, name, type, role, write] of collectionStates) {
                await this.setObjectNotExistsAsync(`${path}.${stateId}`, {
                    type: 'state', common: {
                        name, type, role, read: true, write,
                        ...(stateId === 'brightness' ? { min: 0, max: 100, unit: '%' } : {}),
                        ...(stateId === 'kelvin' ? { min: 1500, max: 9000, unit: 'K' } : {}),
                        ...(stateId === 'mood' ? {
                            states: moodStates,
                            desc: 'Wendet die Stimmungs-Farbpalette auf alle lokal erreichbaren Lampen dieser Gruppe oder dieses Standorts an',
                        } : {}),
                    }, native: {},
                });
            }
            if (this.config.moodsEnabled !== false) {
                await this.extendObjectAsync(`${path}.mood`, { common: { states: moodStates } });
                const currentMood = await this.getStateAsync(`${path}.mood`);
                if (!currentMood || !Object.hasOwn(moodStates, String(currentMood.val))) {
                    await this.setStateAsync(`${path}.mood`, { val: 'none', ack: true });
                }
            }
            await this.setStateAsync(`${path}.name`, { val: collection.name || id, ack: true });
            await this.setStateAsync(`${path}.members`, { val: JSON.stringify(collection.members), ack: true });
            await this.setStateAsync(`${path}.power`, { val: collection.power === 'on', ack: true });
            const brightnessValues = lights.filter(light => light[collectionKey]?.id === id)
                .map(light => Number(light.brightness)).filter(Number.isFinite);
            if (brightnessValues.length) await this.setStateAsync(`${path}.brightness`, { val: Math.round(Math.max(...brightnessValues) * 100), ack: true });
        }
    }

    async syncCloudScenes(scenes) {
        await this.ensureLocalSceneObjects();
        for (const scene of scenes) {
            if (!scene.uuid) continue;
            const safeId = encodeURIComponent(scene.uuid).replace(/%/g, '_');
            const path = `Scenes.${safeId}`;
            await this.setObjectNotExistsAsync(path, {
                type: 'channel', common: { name: scene.name || scene.uuid, role: 'channel' },
                native: { sceneId: scene.uuid },
            });
            await this.setObjectNotExistsAsync(`${path}.activate`, {
                type: 'state',
                common: { name: 'Szene aktivieren', type: 'boolean', role: 'button', read: false, write: true },
                native: { sceneId: scene.uuid },
            });
        }
    }

    async ensureLocalSceneObjects() {
        await this.setObjectNotExistsAsync('Scenes', {
            type: 'channel', common: { name: 'Szenen', role: 'channel' }, native: {},
        });
        await this.setObjectNotExistsAsync('Scenes.Local', {
            type: 'channel', common: { name: 'Lokale Szenen', role: 'channel' }, native: {},
        });
        await this.setObjectNotExistsAsync('Scenes.Local.newName', {
            type: 'state',
            common: { name: 'Neue Szene speichern / vorhandene Szene überschreiben', type: 'string', role: 'text', read: false, write: true },
            native: {},
        });
    }

    async captureLocalScene(name) {
        const cleanName = String(name || '').trim();
        if (!cleanName) throw new Error('Szenenname darf nicht leer sein');
        const sceneId = cleanName.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
        if (!sceneId) throw new Error('Szenenname enthält keine gültigen Zeichen');
        await this.ensureLocalSceneObjects();
        const snapshot = [];
        for (const light of client.lights() || []) {
            const read = async key => (await this.getStateAsync(`Bulb_${light.id}.${key}`))?.val;
            const current = {
                id: String(light.id),
                power: Boolean(await read('state')),
                brightness: Number(await read('bright')) || 0,
                hue: Number(await read('hue')) || 0,
                saturation: Number(await read('sat')) || 0,
                kelvin: Number(await read('temp')) || 3500,
            };
            snapshot.push(current);
        }
        const path = `Scenes.Local.${sceneId}`;
        await this.setObjectNotExistsAsync(path, {
            type: 'channel', common: { name: cleanName, role: 'channel' }, native: { localScene: true, snapshot },
        });
        await this.extendObjectAsync(path, { common: { name: cleanName }, native: { localScene: true, snapshot } });
        for (const [id, name] of [['activate', 'Szene aktivieren'], ['capture', 'Aktuellen Zustand speichern'], ['delete', 'Szene löschen']]) {
            await this.setObjectNotExistsAsync(`${path}.${id}`, {
                type: 'state', common: { name, type: 'boolean', role: 'button', read: false, write: true }, native: {},
            });
        }
        await this.setStateAsync('Scenes.Local.newName', { val: '', ack: true });
        this.log.info(`Saved local LIFX scene '${cleanName}' with ${snapshot.length} lights`);
        return sceneId;
    }

    async activateLocalScene(path) {
        const object = await this.getObjectAsync(path);
        const snapshot = object?.native?.snapshot;
        if (!object?.native?.localScene || !Array.isArray(snapshot)) throw new Error('Lokale Szene nicht gefunden');
        const configuredDuration = Number(this.config.moodTransitionDuration);
        const duration = Math.max(0, Number.isFinite(configuredDuration) ? configuredDuration : 1500);
        for (const saved of snapshot) {
            const light = client.light(saved.id);
            if (!light) continue;
            await new Promise((resolve, reject) => {
                const callback = error => error ? reject(error) : resolve();
                if (saved.power && typeof light.on === 'function') light.on(duration, callback);
                else if (!saved.power && typeof light.off === 'function') light.off(duration, callback);
                else resolve();
            });
            if (saved.power && typeof light.color === 'function') {
                await new Promise((resolve, reject) => light.color(
                    saved.hue, saved.saturation, saved.brightness, saved.kelvin, duration,
                    error => error ? reject(error) : resolve(),
                ));
            }
        }
        await this.setStateAsync(`${path}.activate`, { val: false, ack: true });
    }

    async executeLocalSceneCommand(relativeId, state) {
        if (relativeId === 'Scenes.Local.newName') {
            await this.captureLocalScene(state.val);
            return true;
        }
        const match = relativeId.match(/^Scenes\.Local\.([^.]+)\.(activate|capture|delete)$/);
        if (!match) return false;
        const scenePath = `Scenes.Local.${match[1]}`;
        if (!state.val) return true;
        if (match[2] === 'activate') {
            await this.activateLocalScene(scenePath);
        } else if (match[2] === 'capture') {
            const scene = await this.getObjectAsync(scenePath);
            if (!scene?.native?.localScene) throw new Error('Lokale Szene nicht gefunden');
            const name = scene.common?.name || match[1];
            await this.captureLocalScene(name);
        } else {
            await this.delObjectAsync(scenePath, { recursive: true });
        }
        const commandId = `${scenePath}.${match[2]}`;
        if (match[2] !== 'delete') await this.setStateAsync(commandId, { val: false, ack: true });
        return true;
    }

    scheduleRoutines(delay = 0) {
        if (this.stopping || this.config.schedulesEnabled === false || !this.config.cloudEnabled || !this.config.cloudToken) return;
        if (this.routineTimeout) clearTimeout(this.routineTimeout);
        this.routineTimeout = setTimeout(async () => {
            try {
                const zone = String(this.config.scheduleTimezone || 'Europe/Berlin');
                const clock = routines.localClock(new Date(), zone);
                await this.setObjectNotExistsAsync('info.scheduleRuns', {
                    type: 'state',
                    common: { name: 'Letzte lokale Zeitplanausführungen', type: 'string', role: 'json', read: true, write: false },
                    native: {},
                });
                const runState = await this.getStateAsync('info.scheduleRuns');
                let persistentRuns = {};
                try { persistentRuns = JSON.parse(runState?.val || '{}'); } catch { persistentRuns = {}; }
                for (const row of Array.isArray(this.config.schedules) ? this.config.schedules : []) {
                    const routine = routines.parseRoutine(row);
                    if (!routine || !routines.shouldRun(routine, clock)) continue;
                    const executionKey = `${routine.id}:${clock.date}`;
                    if (this.lastRoutineRuns.get(routine.id) === clock.date || persistentRuns[routine.id] === clock.date) continue;
                    try {
                        const body = { ...routine.state, duration: Number(this.config.collectionTransition) || 1 };
                        await this.cloudRequest(`/lights/${encodeURIComponent(routine.selector)}/state`, 'PUT', body);
                        this.lastRoutineRuns.set(routine.id, clock.date);
                        persistentRuns[routine.id] = clock.date;
                        await this.setStateAsync('info.scheduleRuns', { val: JSON.stringify(persistentRuns), ack: true });
                        this.log.info(`Executed LIFX schedule '${routine.id}' at ${clock.time} (${zone})`);
                    } catch (error) {
                        this.log.warn(`LIFX schedule '${routine.id}' failed: ${error.message || error}`);
                    }
                }
            } catch (error) {
                this.log.warn(`Could not evaluate LIFX schedules: ${error.message || error}`);
            }
            this.scheduleRoutines(15000);
        }, delay);
    }

    async executeCloudEffect(lightId, effect) {
        if (!this.config.cloudEnabled || !this.config.cloudToken) throw new Error('LIFX Cloud ist nicht aktiviert');
        const selector = `id:${lightId}`;
        const endpoints = {
            off: [`/lights/${encodeURIComponent(selector)}/effects/off`, {}],
            clouds: [`/lights/${encodeURIComponent(selector)}/effects/clouds`, { power_on: true }],
            sunrise: [`/lights/${encodeURIComponent(selector)}/effects/sunrise`, { power_on: true }],
            sunset: [`/lights/${encodeURIComponent(selector)}/effects/sunset`, { power_on: true }],
            morph: [`/lights/${encodeURIComponent(selector)}/effects/morph`, { power_on: true }],
            flame: [`/lights/${encodeURIComponent(selector)}/effects/flame`, { power_on: true }],
            move: [`/lights/${encodeURIComponent(selector)}/effects/move`, { power_on: true }],
            clean: [`/lights/${encodeURIComponent(selector)}/clean`, {}],
        };
        if (!Object.hasOwn(endpoints, effect)) throw new Error(`Unbekannter Cloud-Effekt '${effect}'`);
        const [path, body] = endpoints[effect];
        await this.cloudRequest(path, 'POST', body);
        await this.setStateAsync(`Bulb_${lightId}.cloudEffect`, { val: effect, ack: true });
    }

    async executeZonePower(lightId, zone, enabled) {
        const path = `Bulb_${lightId}.zone_${zone}`;
        const light = client.light(lightId);
        if (!light || typeof light.colorZones !== 'function') throw new Error('LIFX-Zone ist nicht erreichbar');
        const read = async key => (await this.getStateAsync(`${path}.${key}`))?.val;
        const hue = Number(await read('hue')) || 0;
        const saturation = Number(await read('sat')) || 0;
        const kelvin = Number(await read('temp')) || 3500;
        const cacheKey = `${lightId}:${zone}`;
        let brightness;
        if (enabled) {
            brightness = this.zoneBrightness.get(cacheKey) || 100;
        } else {
            const current = Number(await read('bright')) || 0;
            if (current > 0) this.zoneBrightness.set(cacheKey, current);
            brightness = 0;
        }
        await new Promise((resolve, reject) => light.colorZones(
            zone, zone, hue, saturation, brightness, kelvin, 500, true,
            error => error ? reject(error) : resolve(),
        ));
        await this.setStateAsync(`${path}.bright`, { val: brightness, ack: true });
        await this.setStateAsync(`${path}.zonePower`, { val: Boolean(enabled), ack: true });
    }

    async executeCloudCommand(relativeId, state) {
        const parts = relativeId.split('.');
        if (relativeId.startsWith('Scenes.Local.')) return this.executeLocalSceneCommand(relativeId, state);
        if (parts[0].startsWith('Bulb_') && parts.at(-1) === 'cloudEffect') {
            const lightId = parts[0].slice('Bulb_'.length);
            await this.executeCloudEffect(lightId, String(state.val));
            return true;
        }
        if ((parts[0] === 'Groups' || parts[0] === 'Locations') && parts.at(-1) === 'mood') {
            try {
                if (state.val && state.val !== 'none') await this.executeCollectionMood(relativeId, String(state.val));
            } finally {
                await this.setStateAsync(relativeId, { val: 'none', ack: true });
            }
            return true;
        }
        if (parts[0] === 'Scenes' && parts.at(-1) === 'activate') {
            const object = await this.getObjectAsync(relativeId);
            const sceneId = object?.native?.sceneId;
            if (!sceneId) return false;
            if (state.val) await this.cloudRequest(`/scenes/scene_id:${encodeURIComponent(sceneId)}/activate`, 'PUT', {});
            await this.setStateAsync(relativeId, { val: false, ack: true });
            return true;
        }
        if ((parts[0] === 'Groups' || parts[0] === 'Locations') && parts.at(-1) === 'power') {
            const channelId = parts.slice(0, -1).join('.');
            const object = await this.getObjectAsync(channelId);
            const lifxId = object?.native?.lifxId;
            if (!lifxId) return false;
            const selectorKey = parts[0] === 'Groups' ? 'group_id' : 'location_id';
            const selector = `${selectorKey}:${lifxId}`;
            await this.cloudRequest(`/lights/${encodeURIComponent(selector)}/state`, 'PUT', { power: state.val ? 'on' : 'off' });
            await this.setStateAsync(relativeId, { val: Boolean(state.val), ack: true });
            return true;
        }
        if ((parts[0] === 'Groups' || parts[0] === 'Locations') && ['brightness', 'color', 'kelvin'].includes(parts.at(-1))) {
            const channelId = parts.slice(0, -1).join('.');
            const object = await this.getObjectAsync(channelId);
            const lifxId = object?.native?.lifxId;
            if (!lifxId) return false;
            const selectorKey = parts[0] === 'Groups' ? 'group_id' : 'location_id';
            const selector = `${selectorKey}:${lifxId}`;
            let body;
            if (parts.at(-1) === 'brightness') {
                const value = Number(state.val);
                if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Helligkeit muss zwischen 0 und 100 liegen');
                body = { brightness: value / 100 };
            } else if (parts.at(-1) === 'kelvin') {
                const value = Number(state.val);
                if (!Number.isFinite(value) || value < 1500 || value > 9000) throw new Error('Farbtemperatur muss zwischen 1500 und 9000 Kelvin liegen');
                body = { color: `kelvin:${Math.round(value)}` };
            } else {
                if (typeof state.val !== 'string' || !/^#[0-9a-f]{6}$/i.test(state.val)) throw new Error('Farbe muss das Format #RRGGBB haben');
                body = { color: state.val };
            }
            body.duration = Number(this.config.collectionTransition) || 1;
            await this.cloudRequest(`/lights/${encodeURIComponent(selector)}/state`, 'PUT', body);
            await this.setStateAsync(relativeId, { val: state.val, ack: true });
            return true;
        }
        return false;
    }

    async pollLifxData() {
        try {
            await this.updateDevices();
            this.log.debug('LIFX polling completed');
        } catch (error) {
            this.log.warn('LIFX polling failed: ' + (error?.message || error));
        } finally {
            if (!this.stopping) {
                const configuredInterval = Number(this.config.lifx_interval);
                const interval = Number.isFinite(configuredInterval)
                    ? Math.min(3600, Math.max(5, configuredInterval))
                    : 30;
                lifxTimeout = setTimeout(() => this.pollLifxData(), interval * 1000);
            }
        }
    }

    async updateDevices() {
        const lights = client.lights('on') || [];
        await Promise.allSettled(lights.map(light => this.updateOneDevice(light)));
    }

    async updateOneDevice(light) {
        const path = 'Bulb_' + light.id;
        try {
            if (!(await this.getObjectAsync(path + '.label'))) {
                await this.createBasic(light.id, 'LIFX ' + light.id, 1500, 9000);
            }
            const state = await this.requestLightData(light, 'getState');
            if (!state) throw new Error('No state received from light');
            const color = state.color || {};
            for (const [stateId, value] of [
                ['label', state.label || 'LIFX ' + light.id],
                ['rename', state.label || 'LIFX ' + light.id],
                ['online', true],
                ['lastSeen', Date.now()],
                ['state', state.power === 1],
                ['hue', color.hue ?? 0],
                ['sat', color.saturation ?? 0],
                ['bright', color.brightness ?? 0],
                ['temp', color.kelvin ?? 3500],
            ]) {
                await this.setStateAsync(path + '.' + stateId, { val: value, ack: true });
            }
        } catch (error) {
            this.log.debug('Failed updating ' + light.id + '; treating it as offline: ' + (error.message || error));
            try {
                await this.stopEffect(light.id, false);
                runningTileEffects.delete(light.id);
                tileEffectInstances.delete(light.id);
                if (await this.getObjectAsync(path + '.tileEffect')) {
                    await this.setStateAsync(path + '.tileEffect', { val: 'off', ack: true });
                }
                await this.setStateAsync(path + '.online', { val: false, ack: true });
                await this.setStateAsync(path + '.effect', { val: 'off', ack: true });
            } catch (stateError) {
                this.log.warn('Could not mark ' + light.id + ' offline: ' + (stateError.message || stateError));
            }
            return;
        }

        try {
            const info = await this.requestLightData(light, 'getHardwareVersion');
            if (info?.productFeatures?.infrared === true) {
                await this.createInfrared(light.id);
                const infrared = await this.requestLightData(light, 'getMaxIR');
                if (infrared && Number.isFinite(Number(infrared.brightness))) {
                    await this.setStateAsync(path + '.infraredBrightness', {
                        val: Number(infrared.brightness),
                        ack: true,
                    });
                }
            }
            if (info?.productFeatures?.multizone === true) {
                await this.createZoneEffect(light.id);
                const zoneInfo = await this.requestLightData(light, 'getColorZones', 0, 255);
                const count = Math.max(0, Number(zoneInfo?.count) || 0);
                for (let offset = 0; offset < count; offset += 8) {
                    const result = await this.requestLightData(
                        light,
                        'getColorZones',
                        offset,
                        Math.min(offset + 7, count - 1),
                    );
                    for (let index = 0; index < (result?.color?.length || 0); index++) {
                        const zone = Number(result.index) + index;
                        await this.createZone(light.id, zone);
                        const color = result.color[index];
                        for (const [key, value] of [
                            ['hue', color.hue],
                            ['sat', color.saturation],
                            ['bright', color.brightness],
                            ['temp', color.kelvin],
                        ]) {
                            await this.setStateAsync(path + '.zone_' + zone + '.' + key, { val: value, ack: true });
                        }
                        this.zoneBrightness.set(`${light.id}:${zone}`, Number(color.brightness) || 0);
                        await this.setStateAsync(path + `.zone_${zone}.zonePower`, { val: Number(color.brightness) > 0, ack: true });
                    }
                }
            }
        } catch (error) {
            this.log.debug('Could not refresh hardware or zone data for ' + light.id + ': ' + (error.message || error));
        }
    }
    async createBasic(id, label, minK, maxK) {
        await this.setObjectNotExistsAsync(`Bulb_${id}`, {
            type: 'channel',
            common: {
                name: `LifxBulb ${label}`,
                role: 'light.color.rgbw', //andere Rolle?
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.label`, {
            type: 'state',
            common: {
                name: 'Label',
                type: 'string',
                role: 'info.name',
                read: true,
                write: false,
                desc: 'Label',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.rename`, {
            type: 'state',
            common: {
                name: 'Lampe umbenennen',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                desc: 'Neuen Namen auf der LIFX-Lampe speichern (max. 32 UTF-8-Bytes)',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.vendor`, {
            type: 'state',
            common: {
                name: 'Vendor',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                desc: 'Vendor',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.product`, {
            type: 'state',
            common: {
                name: 'Product',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                desc: 'product',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.version`, {
            type: 'state',
            common: {
                name: 'Version',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                desc: 'Version',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.colorLamp`, {
            type: 'state',
            common: {
                name: 'color lamp',
                type: 'boolean',
                role: 'sensor',
                read: true,
                write: false,
                desc: 'color Lamp',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.infraredLamp`, {
            type: 'state',
            common: {
                name: 'infrared lamp',
                type: 'boolean',
                role: 'sensor',
                read: true,
                write: false,
                desc: 'infrared lamp',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.multizoneLamp`, {
            type: 'state',
            common: {
                name: 'multizoneLamp',
                type: 'boolean',
                role: 'sensor',
                read: true,
                write: false,
                desc: 'multizoneLamp',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.matrixLamp`, {
            type: 'state',
            common: {
                name: 'Matrixzonen verfügbar',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.state`, {
            type: 'state',
            common: {
                name: 'Licht Ein/Aus',
                type: 'boolean',
                role: 'light.switch',
                read: true,
                write: true,
                desc: 'Licht Ein/Aus',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.duration`, {
            type: 'state',
            common: {
                name: 'Licht Aenderungsgeschwindigkeit ms',
                type: 'number',
                role: 'level.color.dur',
                read: true,
                write: true,
                desc: 'Licht Aenderungsgeschwindigkeit ms',
                min: 0,
                max: 100000,
                unit: 'ms',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.bright`, {
            type: 'state',
            common: {
                name: 'Licht Helligkeit',
                type: 'number',
                role: 'level.color.bri',
                read: true,
                write: true,
                desc: 'Licht Helligkeit',
                min: 0,
                max: 100,
            },
            native: {},
        });
        //min, max anhand von getFeatures "temperature_range":[1500,4000] einstellen
        await this.setObjectNotExistsAsync(`Bulb_${id}.temp`, {
            type: 'state',
            common: {
                name: 'Licht Farbtemp',
                type: 'number',
                role: 'level.color.temp',
                read: true,
                write: true,
                desc: 'Licht Farbtemp',
                min: minK,
                max: maxK,
                unit: 'Kelvin',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.online`, {
            type: 'state',
            common: {
                name: 'Licht Erreichbar',
                type: 'boolean',
                role: 'indicator.reachable',
                read: true,
                write: false,
                desc: 'Licht erreichbar',
            },
            native: {},
        });
        for (const [stateId, name, type, role, unit] of [
            ['lastSeen', 'Zuletzt erreichbar', 'number', 'value.time', 'ms'],
            ['wifiSignal', 'WLAN-Signal (LIFX Rohwert)', 'number', 'value', 'mW'],
            ['wifiTx', 'WLAN gesendete Pakete', 'number', 'value', ''],
            ['wifiRx', 'WLAN empfangene Pakete', 'number', 'value', ''],
        ]) {
            await this.setObjectNotExistsAsync(`Bulb_${id}.${stateId}`, {
                type: 'state',
                common: { name, type, role, read: true, write: false, ...(unit ? { unit } : {}) },
                native: {},
            });
        }
        await this.setObjectNotExistsAsync(`Bulb_${id}.firmwareVersion`, {
            type: 'state',
            common: { name: 'Firmware-Version', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        for (const [stateId, name] of [['group', 'Gruppe'], ['groupId', 'Gruppen-ID'], ['location', 'Standort'], ['locationId', 'Standort-ID']]) {
            await this.setObjectNotExistsAsync(`Bulb_${id}.${stateId}`, {
                type: 'state', common: { name, type: 'string', role: 'text', read: true, write: false }, native: {},
            });
        }
        await this.setObjectNotExistsAsync(`Bulb_${id}.hue`, {
            type: 'state',
            common: {
                name: 'Licht Farbe',
                type: 'number',
                role: 'level.color.hue',
                read: true,
                write: true,
                desc: 'Licht Farbe',
                min: 0,
                max: 360,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.sat`, {
            type: 'state',
            common: {
                name: 'Licht Sättigung',
                type: 'number',
                role: 'level.color.sat',
                read: true,
                write: true,
                desc: 'Licht Sättigung',
                min: 0,
                max: 100,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.effect`, {
            type: 'state',
            common: {
                name: 'Lichteffekt',
                type: 'string',
                role: 'level',
                read: true,
                write: true,
                states: { off: 'Aus', breathe: 'Atmen', pulse: 'Pulsieren', colorLoop: 'Farbwechsel' },
            },
            native: {},
        });
        await this.extendObjectAsync(`Bulb_${id}`, { common: { name: `LifxBulb ${label}` } });
        await this.extendObjectAsync(`Bulb_${id}.temp`, { common: { min: minK, max: maxK } });
        await this.extendObjectAsync(`Bulb_${id}.online`, { common: { write: false } });

        const duration = await this.getStateAsync(`Bulb_${id}.duration`);
        if (duration == null || duration.val == null) {
            await this.setStateAsync(`Bulb_${id}.duration`, { val: 500, ack: true });
        }
        const online = await this.getStateAsync(`Bulb_${id}.online`);
        if (online == null || online.val == null) {
            await this.setStateAsync(`Bulb_${id}.online`, { val: false, ack: true });
        }
        const effect = await this.getStateAsync(`Bulb_${id}.effect`);
        if (effect == null || effect.val == null) {
            await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
        }
        for (const stateId of ['label', 'rename']) {
            const current = await this.getStateAsync(`Bulb_${id}.${stateId}`);
            if (current == null || current.val == null) {
                await this.setStateAsync(`Bulb_${id}.${stateId}`, { val: label, ack: true });
            }
        }
        const matrixCapability = await this.getStateAsync(`Bulb_${id}.matrixLamp`);
        if (matrixCapability == null || matrixCapability.val == null) {
            await this.setStateAsync(`Bulb_${id}.matrixLamp`, { val: false, ack: true });
        }
    }
    async createColor(id) {
        await this.setObjectNotExistsAsync(`Bulb_${id}.colormode`, {
            type: 'state',
            common: {
                name: 'Licht Colormode',
                type: 'string',
                role: 'indicator.colormode',
                read: true,
                write: false,
                desc: 'Licht Colormode',
            },
            native: {},
        });
        await this.extendObjectAsync(`Bulb_${id}.colormode`, { common: { write: false } });
    }

    async getEffectColor(id) {
        const getNumber = async (stateId, fallback) => {
            const state = await this.getStateAsync(`Bulb_${id}.${stateId}`);
            const value = Number(state?.val);
            return Number.isFinite(value) ? value : fallback;
        };
        return {
            hue: await getNumber('hue', 0),
            saturation: await getNumber('sat', 0),
            brightness: await getNumber('bright', 100),
            kelvin: await getNumber('temp', 3500),
        };
    }

    setLightColor(light, color, duration, id) {
        light.color(color.hue, color.saturation, color.brightness, color.kelvin, duration, error => {
            if (error) this.log.debug(`Setting effect color for ${id} failed: ${error.message || error}`);
        });
    }

    async stopEffect(id, restore = true) {
        const run = effectRuns.get(id);
        if (run) {
            if (run.interval) clearInterval(run.interval);
            if (run.timeout) clearTimeout(run.timeout);
            effectRuns.delete(id);
            if (restore && run.originalColor) {
                const light = client.light(id);
                if (light) this.setLightColor(light, run.originalColor, 300, id);
            }
        }
    }

    async executeLocalEffect(id, effect) {
        const light = client.light(id);
        if (!light) {
            this.log.warn(`Cannot start effect for ${id}: light is not available`);
            await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
            return;
        }

        if (effect === 'colorLoop') {
            const supportsColor = await this.getStateAsync(`Bulb_${id}.colorLamp`);
            if (supportsColor?.val !== true) {
                this.log.warn(`Color Loop is only available for color-capable LIFX devices (${id})`);
                await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
                return;
            }
        }

        await this.stopEffect(id, true);
        const originalColor = await this.getEffectColor(id);
        if (effect === 'off') {
            this.setLightColor(light, originalColor, 300, id);
            await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
            return;
        }

        const period = Math.min(10000, Math.max(100, Number(this.config.effectPeriod) || 1000));
        const cycles = Math.min(100, Math.max(1, Number(this.config.effectCycles) || 10));
        const hue = Math.min(360, Math.max(0, Number(this.config.effectHue) || 0));
        const readSetting = (key, fallback, min, max) => {
            const raw = this.config[key];
            if (raw === undefined || raw === null || raw === '') return fallback;
            const value = Number(raw);
            return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
        };
        const saturation = readSetting('effectSaturation', 100, 0, 100);
        const brightness = readSetting('effectBrightness', 100, 1, 100);
        const kelvin = readSetting('effectKelvin', 3500, 2500, 9000);
        const target = { hue, saturation, brightness, kelvin };
        const run = { originalColor, interval: null, timeout: null };
        effectRuns.set(id, run);

        if (effect === 'breathe' || effect === 'pulse') {
            const waveform = effect === 'breathe' ? 1 : 4;
            const skewRatio = readSetting('effectPulseDuty', 0.5, 0, 1);
            light.waveform(
                target.hue,
                target.saturation,
                target.brightness,
                target.kelvin,
                true,
                period,
                cycles,
                skewRatio,
                waveform,
                error => {
                    if (error) this.log.warn(`Starting ${effect} effect for ${id} failed: ${error.message || error}`);
                },
            );
        } else if (effect === 'colorLoop') {
            const stepMs = readSetting('effectColorLoopInterval', 3000, 250, 60000);
            let currentHue = 0;
            const changeHue = () => {
                const currentRun = effectRuns.get(id);
                if (currentRun !== run) return;
                this.setLightColor(light, { ...target, hue: currentHue }, Math.min(stepMs, 1000), id);
                currentHue = (currentHue + 30) % 360;
            };
            changeHue();
            run.interval = setInterval(changeHue, stepMs);
        } else {
            effectRuns.delete(id);
            await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
            this.log.warn(`Unsupported effect '${effect}' requested for ${id}`);
            return;
        }

        if (effect === 'breathe' || effect === 'pulse') {
            run.timeout = setTimeout(async () => {
                if (effectRuns.get(id) !== run) return;
                effectRuns.delete(id);
                await this.setStateAsync(`Bulb_${id}.effect`, { val: 'off', ack: true });
            }, period * cycles + 500);
        }
        await this.setStateAsync(`Bulb_${id}.effect`, { val: effect, ack: true });
    }
    async createZone(id, zone) {
        await this.setObjectNotExistsAsync(`Bulb_${id}.zone_${zone}`, {
            type: 'channel',
            common: { name: `Zone ${zone}`, role: 'channel' },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.zone_${zone}.zonePower`, {
            type: 'state',
            common: {
                name: 'Zone ein/aus', type: 'boolean', role: 'switch', read: true, write: true,
                desc: 'Schaltet nur diese Zone aus und stellt beim Einschalten ihre vorherige Helligkeit wieder her',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.zone_${zone}.hue`, {
            type: 'state',
            common: {
                name: 'Licht Farbe',
                type: 'number',
                role: 'level.color.hue',
                read: true,
                write: true,
                desc: 'Licht Farbe',
                min: 0,
                max: 360,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.zone_${zone}.sat`, {
            type: 'state',
            common: {
                name: 'Licht Sättigung',
                type: 'number',
                role: 'level.color.sat',
                read: true,
                write: true,
                desc: 'Licht Sättigung',
                min: 0,
                max: 100,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`Bulb_${id}.zone_${zone}.bright`, {
            type: 'state',
            common: {
                name: 'Licht Helligkeit',
                type: 'number',
                role: 'level.color.bri',
                read: true,
                write: true,
                desc: 'Licht Helligkeit',
                min: 0,
                max: 100,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`Bulb_${id}.zone_${zone}.temp`, {
            type: 'state',
            common: {
                name: 'Licht Farbtemp',
                type: 'number',
                role: 'level.color.temp',
                read: true,
                write: true,
                desc: 'Licht Farbtemp',
                min: 2500,
                max: 9000,
                unit: 'Kelvin',
            },
            native: {},
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - callback
     */
    async onUnload(callback) {
        try {
            this.stopping = true;
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);
            if (lifxTimeout) {
                clearTimeout(lifxTimeout);
            }
            if (diagnosticsTimeout) clearTimeout(diagnosticsTimeout);
            if (cloudTimeout) clearTimeout(cloudTimeout);
            if (this.routineTimeout) clearTimeout(this.routineTimeout);
            if (this.routineTimeout) clearTimeout(this.routineTimeout);
            for (const id of moveEffects.keys()) {
                const light = client.light(id);
                if (light && typeof light.setMultiZoneEffect === 'function') {
                    light.setMultiZoneEffect('OFF', 1500, 'TOWARDS', error => {
                        if (error) this.log.debug(`Could not stop Move effect for ${id}: ${error.message || error}`);
                    });
                }
            }
            moveEffects.clear();
            await Promise.allSettled([...runningTileEffects.keys()].map(id => {
                const light = client.light(id);
                if (!light) return Promise.resolve();
                return tileEffects.sendTileEffect(light, {
                    source: /^[0-9a-f]{8}$/i.test(client.source || '') ? client.source : '4c465831',
                    sequence: this.nextTileSequence(id),
                    effect: 'off',
                    instanceid: tileEffectInstances.get(id),
                    speed: 1500,
                });
            }));
            runningTileEffects.clear();
            tileEffectInstances.clear();
            for (const [id, run] of effectRuns.entries()) {
                if (run.interval) clearInterval(run.interval);
                if (run.timeout) clearTimeout(run.timeout);
                const light = client.light(id);
                if (light && run.originalColor) this.setLightColor(light, run.originalColor, 300, id);
            }
            effectRuns.clear();
            callback();
        } catch (e) {
            this.log.error(e);
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    // 	if (obj) {
    // 		// The object was changed
    // 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    // 	} else {
    // 		// The object was deleted
    // 		this.log.info(`object ${id} deleted`);
    // 	}
    // }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - id
     * @param {ioBroker.State | null | undefined} state -state
     */
    async onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            if (state && !state.ack) {
                const relativeId = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
                if (relativeId.startsWith('Bulb_') && /\.zone_\d+\.zonePower$/.test(relativeId)) {
                    const match = relativeId.match(/^Bulb_(.+)\.zone_(\d+)\.zonePower$/);
                    try {
                        await this.executeZonePower(match[1], Number(match[2]), Boolean(state.val));
                    } catch (error) {
                        this.log.warn(`Zone power command for ${relativeId} failed: ${error.message || error}`);
                    }
                    return;
                }
                if (relativeId.startsWith('Bulb_') && relativeId.endsWith('.zoneEffect')) {
                    const lightId = relativeId.slice('Bulb_'.length, -'.zoneEffect'.length);
                    try {
                        await this.executeZoneEffect(lightId, String(state.val));
                    } catch (error) {
                        this.log.warn(`Zone effect command for ${lightId} failed: ${error.message || error}`);
                        await this.setStateAsync(relativeId, { val: 'off', ack: true });
                    }
                    return;
                }
                if (relativeId.startsWith('Bulb_') && relativeId.endsWith('.tileEffect')) {
                    const lightId = relativeId.slice('Bulb_'.length, -'.tileEffect'.length);
                    try {
                        await this.executeTileEffect(lightId, String(state.val));
                    } catch (error) {
                        this.log.warn(`Matrix effect command for ${lightId} failed: ${error.message || error}`);
                        await this.setStateAsync(relativeId, { val: 'off', ack: true });
                    }
                    return;
                }
                if (relativeId.startsWith('Bulb_') && relativeId.endsWith('.mood')) {
                    const lightId = relativeId.slice('Bulb_'.length, -'.mood'.length);
                    try {
                        if (String(state.val) === 'none') {
                            await this.setStateAsync(relativeId, { val: 'none', ack: true });
                        } else {
                            await this.executeMood(lightId, String(state.val));
                        }
                    } catch (error) {
                        this.log.warn(`Mood command for ${lightId} failed: ${error.message || error}`);
                        await this.setStateAsync(relativeId, { val: 'none', ack: true });
                    }
                    return;
                }
                if (relativeId.startsWith('Bulb_') && relativeId.endsWith('.infraredBrightness')) {
                    const lightId = relativeId.slice('Bulb_'.length, -'.infraredBrightness'.length);
                    try {
                        await this.executeInfrared(lightId, state.val);
                    } catch (error) {
                        this.log.warn(`Infrared command for ${lightId} failed: ${error.message || error}`);
                        const current = await this.requestLightData(client.light(lightId), 'getMaxIR').catch(() => null);
                        if (current && Number.isFinite(Number(current.brightness))) {
                            await this.setStateAsync(relativeId, { val: Number(current.brightness), ack: true });
                        }
                    }
                    return;
                }
                if (relativeId.startsWith('Bulb_') && relativeId.endsWith('.rename')) {
                    const lightId = relativeId.slice('Bulb_'.length, -'.rename'.length);
                    try {
                        await this.renameLight(lightId, state.val);
                    } catch (error) {
                        this.log.warn(`Rename command for ${lightId} failed: ${error.message || error}`);
                        const current = await this.requestLightData(client.light(lightId), 'getLabel').catch(() => null);
                        if (typeof current === 'string') {
                            await this.setStateAsync(relativeId, { val: current, ack: true });
                        }
                    }
                    return;
                }
                if (relativeId.startsWith('Bulb_') && relativeId.endsWith('.effect')) {
                    const lightId = relativeId.slice('Bulb_'.length, -'.effect'.length);
                    try {
                        await this.executeLocalEffect(lightId, String(state.val));
                    } catch (error) {
                        this.log.warn(`Effect command for ${lightId} failed: ${error.message || error}`);
                        await this.setStateAsync(relativeId, { val: 'off', ack: true });
                    }
                    return;
                }
                if ((relativeId.startsWith('Bulb_') && relativeId.endsWith('.cloudEffect')) ||
                    ['Groups.', 'Locations.', 'Scenes.'].some(prefix => relativeId.startsWith(prefix))) {
                    try {
                        await this.executeCloudCommand(relativeId, state);
                    } catch (error) {
                        this.log.warn(`Cloud command for ${relativeId} failed: ${error.message || error}`);
                    }
                    return;
                }
                this.log.debug('ack is not set! -> command');
                const tmp = id.split('.');
                const dp = tmp.pop();
                const idy = tmp.pop();
                let zone = null;

                if (idy.includes('zone')) {
                    const idx = tmp.pop();
                    id = idx.replace(/Bulb_/g, ''); //Bulb
                    zone = parseInt(idy.replace(/zone_/g, '')); //zone
                } else {
                    id = idy.replace(/Bulb_/g, ''); //Bulb
                    this.log.debug(`ID: ${id} identified`);
                }

                this.getState(`Bulb_${id}.duration`, (err, dur) => {
                    const stateValue = (entry, fallback) => (entry && entry.val != null ? entry.val : fallback);
                    if (dp == 'state') {
                        if (state.val == 0) {
                            client.light(id).off(stateValue(dur, 500), err => {
                                if (err) {
                                    this.log.debug(`Turning light ${id} off failed`);
                                }
                                this.log.debug(`Turned light ${id} off`);
                            });
                        } else if (state.val == 1 && !zone) {
                            client.light(id).on(stateValue(dur, 500), err => {
                                if (err) {
                                    this.log.debug(`Turning light ${id} on failed`);
                                }
                                this.log.debug(`Turned light ${id} on`);
                            });
                        }
                    }
                    if (dp == 'temp') {
                        if (zone === null) {
                            this.getState(`Bulb_${id}.bright`, (err, obj) => {
                                client.light(id).color(0, 0, stateValue(obj, 100), state.val, stateValue(dur, 500), err => {
                                    //hue, sat, bright, kelvin, duration
                                    if (err) {
                                        this.log.debug(`White light adjust${id} failed`);
                                    }
                                    this.log.debug(`White light adjust ${id} to: ${state.val} Kelvin`);
                                    this.setStateAsync(`Bulb_${id}.colormode`, {
                                        val: 'white',
                                        ack: true,
                                    });
                                });
                            });
                        } else {
                            this.getState(`Bulb_${id}.zone_${zone}.bright`, (err, obj) => {
                                client
                                    .light(id)
                                    .colorZones(zone, zone, 0, 0, stateValue(obj, 100), state.val, stateValue(dur, 500), true, err => {
                                        //hue, sat, bright, kelvin,duration
                                        if (err) {
                                            this.log.debug(`White light adjust${id} in zone ${zone}failed`);
                                        }
                                        this.log.debug(`White light adjust ${id} zone ${zone} to: ${state.val} Kelvin`);
                                    });
                            });
                        }
                    }

                    if (dp == 'bright') {
                        this.getState(`Bulb_${id}.colormode`, (err, mode) => {
                            if (!mode || mode?.val === 'white') {
                                if (zone === null) {
                                    this.getState(`Bulb_${id}.temp`, (err, obj) => {
                                        client.light(id).color(0, 0, state.val, stateValue(obj, 4000), stateValue(dur, 500), err => {
                                            //hue, sat, bright, kelvin, duration
                                            if (err) {
                                                this.log.debug(`Brightness White adjust ${id} failed`);
                                            }
                                            this.log.debug(`Brightness White adjust ${id} to${state.val} %`);
                                        });
                                    });
                                } else {
                                    this.getState(`Bulb_${id}.zone_${zone}.temp`, (err, obj) => {
                                        client
                                            .light(id)
                                            .colorZones(zone, zone, 0, 0, state.val, stateValue(obj, 4000), stateValue(dur, 500), true, err => {
                                                //hue, sat, bright, kelvin, duration
                                                if (err) {
                                                    this.log.debug(
                                                        `Brightness White adjust ${id} in zone ${zone} failed`,
                                                    );
                                                }
                                                this.log.debug(
                                                    `Brightness White adjust ${id} zone ${zone} to${state.val} %`,
                                                );
                                            });
                                    });
                                }
                            } else {
                                if (zone === null) {
                                    this.getState(`Bulb_${id}.hue`, (err, obj) => {
                                        this.getState(`Bulb_${id}.sat`, (err, sat) => {
                                            this.getState(`Bulb_${id}.temp`, (err, tmp) => {
                                                client
                                                    .light(id)
                                                    .color(stateValue(obj, 0), stateValue(sat, 0), state.val, stateValue(tmp, 4000), stateValue(dur, 500), err => {
                                                        //hue, sat, bright, kelvin, duration
                                                        if (err) {
                                                            this.log.debug(`Brightness Color adjust ${id} failed`);
                                                        }
                                                        this.log.debug(
                                                            `Brightness Color adjust ${id} to${state.val} %`,
                                                        );
                                                    });
                                            });
                                        });
                                    });
                                } else {
                                    this.getState(`Bulb_${id}.zone_${zone}.hue`, (err, obj) => {
                                        this.getState(`Bulb_${id}.zone_${zone}.sat`, (err, sat) => {
                                            this.getState(`Bulb_${id}.zone_${zone}.temp`, (err, tmp) => {
                                                client
                                                    .light(id)
                                                    .colorZones(
                                                        zone,
                                                        zone,
                                                        stateValue(obj, 0),
                                                        stateValue(sat, 0),
                                                        state.val,
                                                        stateValue(tmp, 4000),
                                                        stateValue(dur, 500),
                                                        true,
                                                        err => {
                                                            //hue, sat, bright, kelvin
                                                            if (err) {
                                                                this.log.debug(
                                                                    `Brightness Color adjust ${id} in zone ${
                                                                        zone
                                                                    } failed`,
                                                                );
                                                            }
                                                            this.log.debug(
                                                                `Brightness Color adjust ${id} zone ${zone} to${
                                                                    state.val
                                                                } %`,
                                                            );
                                                        },
                                                    );
                                            });
                                        });
                                    });
                                }
                            }
                        }); // get colormode
                    }

                    if (dp == 'hue') {
                        if (zone === null) {
                            this.getState(`Bulb_${id}.sat`, (err, obj) => {
                                this.getState(`Bulb_${id}.bright`, (err, bri) => {
                                    this.getState(`Bulb_${id}.temp`, (err, tmp) => {
                                        client.light(id).color(state.val, stateValue(obj, 0), stateValue(bri, 100), stateValue(tmp, 4000), stateValue(dur, 500), err => {
                                            //hue, sat, bright, kelvin
                                            if (err) {
                                                this.log.debug(`Coloring light ${id} failed`);
                                            }
                                            this.log.debug(`Coloring light ${id} to: ${state.val} °`);
                                            this.setStateAsync(`Bulb_${id}.colormode`, {
                                                val: 'color',
                                                ack: true,
                                            });
                                        });
                                    });
                                });
                            });
                        } else {
                            this.getState(`Bulb_${id}.zone_${zone}.sat`, (err, obj) => {
                                this.getState(`Bulb_${id}.zone_${zone}.bright`, (err, bri) => {
                                    this.getState(`Bulb_${id}.zone_${zone}.temp`, (err, tmp) => {
                                        client
                                            .light(id)
                                            .colorZones(
                                                zone,
                                                zone,
                                                state.val,
                                                stateValue(obj, 0),
                                                stateValue(bri, 100),
                                                stateValue(tmp, 4000),
                                                stateValue(dur, 500),
                                                true,
                                                err => {
                                                    //hue, sat, bright, kelvin
                                                    if (err) {
                                                        this.log.debug(`Coloring light ${id} in zone ${zone} failed`);
                                                    }
                                                    this.log.debug(
                                                        `Coloring light ${id} zone ${zone} to: ${state.val} °`,
                                                    );
                                                },
                                            );
                                    });
                                });
                            });
                        }
                    }

                    if (dp == 'sat') {
                        if (zone === null) {
                            this.getState(`Bulb_${id}.hue`, (err, obj) => {
                                this.getState(`Bulb_${id}.bright`, (err, bri) => {
                                    this.getState(`Bulb_${id}.temp`, (err, tmp) => {
                                        client.light(id).color(stateValue(obj, 0), state.val, stateValue(bri, 100), stateValue(tmp, 4000), stateValue(dur, 500), err => {
                                            //hue, sat, bright, kelvin
                                            if (err) {
                                                this.log.debug(`Saturation light ${id} failed`);
                                            }
                                            this.log.debug(`Saturation light ${id} to: ${state.val} %`);
                                            this.setStateAsync(`Bulb_${id}.colormode`, {
                                                val: 'color',
                                                ack: true,
                                            });
                                        });
                                    });
                                });
                            });
                        } else {
                            this.getState(`Bulb_${id}.zone_${zone}.hue`, (err, obj) => {
                                this.getState(`Bulb_${id}.zone_${zone}.bright`, (err, bri) => {
                                    this.getState(`Bulb_${id}.zone_${zone}.temp`, (err, tmp) => {
                                        client
                                            .light(id)
                                            .colorZones(
                                                zone,
                                                zone,
                                                stateValue(obj, 0),
                                                state.val,
                                                stateValue(bri, 100),
                                                stateValue(tmp, 4000),
                                                stateValue(dur, 500),
                                                true,
                                                err => {
                                                    //hue, sat, bright, kelvin
                                                    if (err) {
                                                        this.log.debug(`Saturation light ${id} in zone ${zone} failed`);
                                                    }
                                                    this.log.debug(
                                                        `Saturation light ${id} zone ${zone} to: ${state.val} %`,
                                                    );
                                                },
                                            );
                                    });
                                });
                            });
                        }
                    }
                });
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.messagebox" property to be set to true in io-package.json
     *
     * @param {ioBroker.Message} obj
     */
    /*
	onMessage(obj) {
		if (typeof obj === 'object' && obj.message) {
			if (obj.command === 'send') {
				// e.g. send email or pushover or whatever
				this.log.info('send command');

				// Send response in callback if required
				if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
			}
		}
	}
    */
}
if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] -options
     */
    module.exports = options => new Lifx(options);
} else {
    // otherwise start the instance directly
    new Lifx();
}


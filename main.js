'use strict';

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("node:fs");
const LifxClient = require('lifx-lan-client').Client;
const client = new LifxClient();
let lifxTimeout;
let diagnosticsTimeout;
let cloudTimeout;
const effectRuns = new Map();
const moveEffects = new Map();

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
        this.scheduleDiagnostics(10000);
        if (this.config.cloudEnabled && this.config.cloudToken) {
            this.scheduleCloudSync(10000);
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
        await this.createBasic(light.id, state?.label || `LIFX ${light.id}`, range[0], range[1]);

        for (const [stateId, value] of [
            ['vendor', info.vendorName || ''],
            ['product', info.productName || ''],
            ['version', String(info.version ?? '')],
            ['colorLamp', features.color === true],
            ['infraredLamp', features.infrared === true],
            ['multizoneLamp', features.multizone === true],
            ['label', state?.label || ''],
            ['state', state?.power === 1],
            ['bright', state?.color?.brightness ?? 0],
            ['temp', state?.color?.kelvin ?? range[0]],
            ['online', true],
            ['lastSeen', Date.now()],
        ]) {
            await this.setStateAsync(`Bulb_${light.id}.${stateId}`, { val: value, ack: true });
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
        if (response.status === 204) return null;
        return response.json();
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
            for (const [stateId, name, type, role, write] of [
                ['name', 'Name', 'string', 'info.name', false],
                ['members', 'Lampen', 'string', 'json', false],
                ['power', 'Ein/Aus', 'boolean', 'switch', true],
            ]) {
                await this.setObjectNotExistsAsync(`${path}.${stateId}`, {
                    type: 'state', common: { name, type, role, read: true, write }, native: {},
                });
            }
            await this.setStateAsync(`${path}.name`, { val: collection.name || id, ack: true });
            await this.setStateAsync(`${path}.members`, { val: JSON.stringify(collection.members), ack: true });
            await this.setStateAsync(`${path}.power`, { val: collection.power === 'on', ack: true });
        }
    }

    async syncCloudScenes(scenes) {
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

    async executeCloudCommand(relativeId, state) {
        const parts = relativeId.split('.');
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
                await this.setStateAsync(path + '.online', { val: false, ack: true });
                await this.setStateAsync(path + '.effect', { val: 'off', ack: true });
            } catch (stateError) {
                this.log.warn('Could not mark ' + light.id + ' offline: ' + (stateError.message || stateError));
            }
            return;
        }

        try {
            const info = await this.requestLightData(light, 'getHardwareVersion');
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
            for (const id of moveEffects.keys()) {
                const light = client.light(id);
                if (light && typeof light.setMultiZoneEffect === 'function') {
                    light.setMultiZoneEffect('OFF', 1500, 'TOWARDS', error => {
                        if (error) this.log.debug(`Could not stop Move effect for ${id}: ${error.message || error}`);
                    });
                }
            }
            moveEffects.clear();
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
                if (['Groups.', 'Locations.', 'Scenes.'].some(prefix => relativeId.startsWith(prefix))) {
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


'use strict';

const { DeviceManagement } = require('@iobroker/dm-utils');

const text = (en, de) => ({ en, de });

function hsvToHex(hue, saturation) {
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = Math.min(100, Math.max(0, Number(saturation))) / 100;
    const chroma = s;
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
    const sector = Math.floor(h / 60);
    const rgb = sector === 0 ? [chroma, x, 0]
        : sector === 1 ? [x, chroma, 0]
            : sector === 2 ? [0, chroma, x]
                : sector === 3 ? [0, x, chroma]
                    : sector === 4 ? [x, 0, chroma] : [chroma, 0, x];
    return `#${rgb.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;
}

class LifxDeviceManagement extends DeviceManagement {
    constructor(adapter, getLights) {
        super(adapter);
        this.getLights = getLights;
    }

    async loadDevices(context) {
        const lights = this.getLights() || [];
        context.setTotalDevices(lights.length);

        for (const light of lights) {
            const id = String(light.id);
            const prefix = `Bulb_${id}`;
            const online = await this.adapter.getObjectAsync(`${prefix}.online`);
            if (!online) continue;
            const temperatureObject = await this.adapter.getObjectAsync(`${prefix}.temp`);

            const info = {
                id,
                identifier: id,
                name: { stateId: `${prefix}.label` },
                icon: 'light',
                connectionType: 'wifi',
                manufacturer: { stateId: `${prefix}.vendor` },
                model: { stateId: `${prefix}.product` },
                status: {
                    connection: {
                        stateId: `${prefix}.online`,
                        mapping: { true: 'connected', false: 'disconnected' },
                    },
                },
                hasDetails: true,
                actions: [{
                    id: 'configure',
                    icon: 'settings',
                    title: text('Configure', 'Konfigurieren'),
                    description: text('Change power, brightness and color', 'Ein/Aus, Helligkeit und Farbe ändern'),
                    handler: async (deviceId, actionContext) => {
                        const colorLamp = (await this.adapter.getStateAsync(`Bulb_${deviceId}.colorLamp`))?.val === true;
                        const current = await Promise.all([
                            this.adapter.getStateAsync(`Bulb_${deviceId}.state`),
                            this.adapter.getStateAsync(`Bulb_${deviceId}.bright`),
                            this.adapter.getStateAsync(`Bulb_${deviceId}.hue`),
                            this.adapter.getStateAsync(`Bulb_${deviceId}.sat`),
                        ]);
                        const items = {
                            power: { type: 'checkbox', label: text('Power', 'Ein/Aus'), sm: 12 },
                            brightness: {
                                type: 'number', label: text('Brightness (%)', 'Helligkeit (%)'),
                                min: 0, max: 100, step: 1, sm: 12,
                            },
                        };
                        if (colorLamp) {
                            items.color = {
                                type: 'color', label: text('Color', 'Farbe'), sm: 12,
                            };
                        }
                        const data = await actionContext.showForm({ type: 'panel', items }, {
                            title: text('Configure LIFX lamp', 'LIFX-Lampe konfigurieren'),
                            data: {
                                power: current[0]?.val === true || current[0]?.val === 1,
                                brightness: Number(current[1]?.val) || 0,
                                ...(colorLamp ? { color: hsvToHex(Number(current[2]?.val) || 0, Number(current[3]?.val) || 0) } : {}),
                            },
                        });
                        if (!data) return { refresh: false };
                        await this.adapter.configureLight(String(deviceId), data);
                        return { refresh: 'all' };
                    },
                }, {
                    id: 'refresh',
                    icon: 'refresh',
                    title: text('Refresh data points', 'Datenpunkte aktualisieren'),
                    description: text('Delete and recreate all data points for this lamp', 'Alle Datenpunkte dieser Lampe löschen und neu anlegen'),
                    handler: async (deviceId, actionContext) => {
                        const confirmed = await actionContext.showConfirmation(text(
                            'All data points for this lamp will be deleted and recreated. Continue?',
                            'Alle Datenpunkte dieser Lampe werden gelöscht und neu angelegt. Fortfahren?',
                        ));
                        if (!confirmed) return { refresh: false };
                        await this.adapter.refreshLightObjects(String(deviceId));
                        return { refresh: 'all' };
                    },
                }, {
                    id: 'rename',
                    icon: 'edit',
                    title: text('Rename', 'Umbenennen'),
                    description: text('Set the name reported by the LIFX lamp', 'Den von der LIFX-Lampe gemeldeten Namen ändern'),
                    handler: async (deviceId, actionContext) => {
                        const current = await this.adapter.getStateAsync(`Bulb_${deviceId}.label`);
                        const data = await actionContext.showForm({
                            type: 'panel',
                            items: {
                                label: {
                                    type: 'text',
                                    label: text('Lamp name (max. 32 UTF-8 bytes)', 'Lampenname (max. 32 UTF-8-Bytes)'),
                                    maxLength: 32,
                                    sm: 12,
                                },
                            },
                        }, {
                            title: text('Rename LIFX lamp', 'LIFX-Lampe umbenennen'),
                            data: { label: String(current?.val || '') },
                        });
                        if (!data) return { refresh: false };
                        await this.adapter.renameLight(String(deviceId), data.label);
                        return { refresh: 'all' };
                    },
                }],
                controls: [
                    {
                        id: 'power', type: 'switch', stateId: `${prefix}.state`,
                        label: text('Power', 'Ein/Aus'), icon: 'light',
                    },
                    {
                        id: 'brightness', type: 'slider', stateId: `${prefix}.bright`,
                        label: text('Brightness', 'Helligkeit'), icon: 'dimmer', min: 0, max: 100, step: 1, unit: '%',
                    },
                    {
                        id: 'temperature', type: 'slider', stateId: `${prefix}.temp`,
                        label: text('Color temperature', 'Farbtemperatur'), icon: 'backlight',
                        min: Number(temperatureObject?.common?.min) || 1500,
                        max: Number(temperatureObject?.common?.max) || 9000,
                        step: 100, unit: 'K',
                    },
                ],
            };

            const color = await this.adapter.getStateAsync(`${prefix}.colorLamp`);
            if (color?.val === true) {
                info.controls.push(
                    {
                        id: 'hue', type: 'slider', stateId: `${prefix}.hue`,
                        label: text('Hue', 'Farbton'), min: 0, max: 360, step: 1, unit: '°',
                    },
                    {
                        id: 'saturation', type: 'slider', stateId: `${prefix}.sat`,
                        label: text('Saturation', 'Sättigung'), min: 0, max: 100, step: 1, unit: '%',
                    },
                );
            }

            context.addDevice(info);
        }
    }

    async getDeviceDetails(id) {
        const prefix = `Bulb_${id}`;
        const infoItems = [
            ['product', 'Product / Produkt'],
            ['version', 'Hardware version / Hardwareversion'],
            ['firmwareVersion', 'Firmware version / Firmwareversion'],
            ['wifiSignal', 'Wi-Fi signal (raw LIFX value) / WLAN-Signal (LIFX-Rohwert)'],
            ['lastSeen', 'Last seen / Zuletzt gesehen'],
        ];
        const items = {};
        for (const [key, label] of infoItems) {
            const state = await this.adapter.getStateAsync(`${prefix}.${key}`);
            if (state?.val !== undefined && state.val !== null && state.val !== '') {
                const value = key === 'lastSeen' && Number.isFinite(Number(state.val))
                    ? new Date(Number(state.val)).toLocaleString()
                    : String(state.val);
                items[key] = { type: 'staticText', text: `${label}: ${value}`, sm: 12 };
            }
        }
        return { id, schema: { type: 'panel', items } };
    }
}

module.exports = LifxDeviceManagement;

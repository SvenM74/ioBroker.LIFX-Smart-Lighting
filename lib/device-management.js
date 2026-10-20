'use strict';

const { DeviceManagement } = require('@iobroker/dm-utils');

const text = (en, de) => ({ en, de });

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

'use strict';

const dgram = require('node:dgram');
const crypto = require('node:crypto');

const EFFECT_TYPES = Object.freeze({ off: 0, morph: 2, flame: 3, sky: 5 });
const PAYLOAD_SIZE = 188;
const HEADER_SIZE = 36;

function byte(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(`${name} must be an integer from 0 to 255`);
    }
    return value;
}

function normalized(value, min, max, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new RangeError(`${name} must be between ${min} and ${max}`);
    }
    return number;
}

function createSetTileEffectPacket({ target, source, sequence, effect, speed, skyType = 0, palette = [], instanceid }) {
    const effectType = EFFECT_TYPES[effect];
    if (effectType === undefined) throw new Error(`Unsupported Tile Effect '${effect}'`);
    if (!/^[0-9a-f]{12}$/i.test(target)) throw new Error('LIFX target must be a 12-character hexadecimal device id');
    if (!/^[0-9a-f]{8}$/i.test(source)) throw new Error('LIFX source must be an 8-character hexadecimal id');
    byte(sequence, 'sequence');
    const cycleMs = Math.round(normalized(speed, 100, 60000, 'speed'));
    byte(skyType, 'skyType');
    if (skyType > 2) throw new RangeError('skyType must be 0 (sunrise), 1 (sunset), or 2 (clouds)');
    if (!Array.isArray(palette) || palette.length > 16) throw new RangeError('palette must contain at most 16 colors');

    const packet = Buffer.alloc(HEADER_SIZE + PAYLOAD_SIZE);
    packet.writeUInt16LE(packet.length, 0);
    // Addressable protocol packet: protocol version 1024 and addressable bit set.
    packet.writeUInt16LE(0x1400, 2);
    Buffer.from(source, 'hex').copy(packet, 4);
    Buffer.from(target, 'hex').copy(packet, 8);
    packet.writeUInt8(sequence, 23);
    packet.writeUInt16LE(719, 32); // SetTileEffect

    const payload = packet.subarray(HEADER_SIZE);
    let offset = 2; // reserved bytes
    const effectInstanceId = Number.isInteger(instanceid) && instanceid >= 0 && instanceid <= 0xffffffff
        ? instanceid
        : crypto.randomBytes(4).readUInt32LE(0);
    payload.writeUInt32LE(effectInstanceId, offset);
    offset += 4;
    payload.writeUInt8(effectType, offset++);
    payload.writeUInt32LE(cycleMs, offset);
    offset += 4;
    payload.writeBigUInt64LE(0n, offset); // zero means the firmware effect runs until stopped
    offset += 8;
    offset += 8; // reserved2 + reserved3
    payload.writeUInt8(skyType, offset++);
    offset += 3; // reserved4
    payload.writeUInt8(50, offset++); // recommended minimum saturation for clouds
    offset += 3; // reserved5
    offset += 24; // reserved6
    payload.writeUInt8(palette.length, offset++);

    for (let index = 0; index < 16; index++) {
        const color = palette[index];
        if (!color) {
            offset += 8;
            continue;
        }
        const hue = normalized(color.hue, 0, 360, `palette[${index}].hue`);
        const saturation = normalized(color.saturation, 0, 100, `palette[${index}].saturation`);
        const brightness = normalized(color.brightness, 0, 100, `palette[${index}].brightness`);
        const kelvin = Math.round(normalized(color.kelvin, 1500, 9000, `palette[${index}].kelvin`));
        payload.writeUInt16LE(Math.round((hue / 360) * 65535), offset);
        payload.writeUInt16LE(Math.round((saturation / 100) * 65535), offset + 2);
        payload.writeUInt16LE(Math.round((brightness / 100) * 65535), offset + 4);
        payload.writeUInt16LE(kelvin, offset + 6);
        offset += 8;
    }
    return packet;
}

function sendTileEffect(light, options) {
    if (!light || typeof light.address !== 'string' || !light.address) {
        return Promise.reject(new Error('LIFX device has no network address'));
    }
    const port = Number(light.port) || 56700;
    const packet = createSetTileEffectPacket({ ...options, target: light.id });
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        let finished = false;
        const finish = error => {
            if (finished) return;
            finished = true;
            socket.close();
            if (error) reject(error);
            else resolve();
        };
        socket.send(packet, port, light.address, finish);
    });
}

module.exports = { EFFECT_TYPES, createSetTileEffectPacket, sendTileEffect };

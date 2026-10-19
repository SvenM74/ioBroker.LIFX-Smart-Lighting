'use strict';

const DEFAULT_MOODS = [
    { id: 'sunset', name: 'Sonnenuntergang', colors: '#FF4B1F,#FF9A3C,#6B2D70' },
    { id: 'ocean', name: 'Ozean', colors: '#082C8C,#007FA8,#62E6D8' },
    { id: 'forest', name: 'Wald', colors: '#123D2B,#32834A,#B4D68A' },
    { id: 'aurora', name: 'Polarlicht', colors: '#163A9B,#00C99A,#9B54E8' },
    { id: 'cozy', name: 'Gemütlich', colors: '#FF6A2A,#FFB34A,#FFE0A0' },
];

function parseColor(value) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!match) return null;
    const hex = match[1];
    const red = parseInt(hex.slice(0, 2), 16) / 255;
    const green = parseInt(hex.slice(2, 4), 16) / 255;
    const blue = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let hue = 0;
    if (delta) {
        if (max === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (max === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return {
        hue: Math.round(hue),
        saturation: max === 0 ? 0 : Math.round((delta / max) * 100),
        brightness: Math.round(max * 100),
        kelvin: 3500,
    };
}

function normalizeMoodPresets(configured) {
    const rows = Array.isArray(configured) && configured.length ? configured : DEFAULT_MOODS;
    const seen = new Set();
    const result = [];
    for (const row of rows) {
        const id = String(row?.id || '').trim().toLowerCase();
        const name = String(row?.name || '').trim();
        const colors = String(row?.colors || '').split(',').map(parseColor).filter(Boolean);
        if (!/^[a-z0-9_-]{1,32}$/.test(id) || id === 'none' || seen.has(id) || !name || !colors.length) continue;
        seen.add(id);
        result.push({ id, name, colors });
    }
    return result;
}

function paletteColorForDevice(palette, deviceId) {
    if (!palette.length) return null;
    let hash = 0;
    for (const char of String(deviceId)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
}

function colorForZone(palette, zone, zoneCount) {
    if (!palette.length) return null;
    if (palette.length === 1 || zoneCount <= 1) return palette[0];
    const position = (zone / (zoneCount - 1)) * (palette.length - 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(palette.length - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = palette[leftIndex];
    const right = palette[rightIndex];
    const hueDelta = ((right.hue - left.hue + 540) % 360) - 180;
    const hue = (left.hue + hueDelta * fraction + 360) % 360;
    const mix = (a, b) => Math.round(a + (b - a) * fraction);
    return {
        hue: Math.round(hue),
        saturation: mix(left.saturation, right.saturation),
        brightness: mix(left.brightness, right.brightness),
        kelvin: mix(left.kelvin, right.kelvin),
    };
}

module.exports = { DEFAULT_MOODS, colorForZone, normalizeMoodPresets, paletteColorForDevice };

'use strict';

function localClock(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return {
        date: `${values.year}-${values.month}-${values.day}`,
        day: weekdays[values.weekday],
        time: `${values.hour}:${values.minute}`,
    };
}

function parseRoutine(row) {
    if (!row || typeof row !== 'object') return null;
    const id = String(row.id || '').trim();
    const time = String(row.time || '').trim();
    const selector = String(row.selector || '').trim();
    const days = String(row.days || '*').trim();
    if (!/^[a-z0-9_-]{1,40}$/i.test(id) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    if (!(selector === 'all' || /^(?:id|group_id|location_id):[a-zA-Z0-9_-]+$/.test(selector))) return null;
    if (!(days === '*' || /^[1-7](?:,[1-7])*$/.test(days))) return null;
    const state = {};
    const power = String(row.power || '').trim().toLowerCase();
    if (power === 'on' || power === 'off') state.power = power;
    if (row.brightness !== '' && row.brightness != null && Number.isFinite(Number(row.brightness))) {
        const value = Number(row.brightness);
        if (value < 0 || value > 100) return null;
        state.brightness = value / 100;
    }
    const color = String(row.color || '').trim();
    if (color) {
        if (!/^(#[0-9a-f]{6}|(?:hue|saturation|brightness|kelvin):[\d.]+(?:\s+(?:hue|saturation|brightness|kelvin):[\d.]+)*)$/i.test(color)) return null;
        state.color = color;
    }
    if (row.kelvin !== '' && row.kelvin != null && Number.isFinite(Number(row.kelvin))) {
        const value = Number(row.kelvin);
        if (value < 1500 || value > 9000) return null;
        state.color = [state.color, `kelvin:${Math.round(value)}`].filter(Boolean).join(' ');
    }
    if (!Object.keys(state).length) return null;
    return { id, time, selector, days, state };
}

function shouldRun(routine, clock) {
    if (!routine || routine.time !== clock.time) return false;
    return routine.days === '*' || routine.days.split(',').includes(String(clock.day));
}

module.exports = { localClock, parseRoutine, shouldRun };

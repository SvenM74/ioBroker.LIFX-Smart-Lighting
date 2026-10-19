'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localClock, parseRoutine, shouldRun } = require('../lib/routines');

test('routine converts its scheduled color and brightness to Cloud API values', () => {
    assert.deepEqual(parseRoutine({
        id: 'evening', time: '20:30', days: '1,2,3,4,5', selector: 'group_id:abc-123',
        power: 'on', brightness: 65, color: '#ffaa00', kelvin: 2700,
    }), {
        id: 'evening', time: '20:30', days: '1,2,3,4,5', selector: 'group_id:abc-123',
        state: { power: 'on', brightness: 0.65, color: '#ffaa00 kelvin:2700' },
    });
});

test('routine parser rejects unsafe selectors, invalid times and empty actions', () => {
    assert.equal(parseRoutine({ id: 'x', time: '25:00', selector: 'all', power: 'on' }), null);
    assert.equal(parseRoutine({ id: 'x', time: '09:00', selector: 'all;delete', power: 'on' }), null);
    assert.equal(parseRoutine({ id: 'x', time: '09:00', selector: 'all' }), null);
});

test('routine weekday matching and time-zone conversion are stable', () => {
    assert.equal(shouldRun({ time: '09:00', days: '1,2' }, { time: '09:00', day: 2 }), true);
    assert.equal(shouldRun({ time: '09:00', days: '1,2' }, { time: '09:00', day: 3 }), false);
    assert.deepEqual(localClock(new Date('2026-10-19T07:30:00Z'), 'Europe/Berlin'), {
        date: '2026-10-19', day: 1, time: '09:30',
    });
});

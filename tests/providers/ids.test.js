import { describe, it, expect } from 'vitest';
const { serviceIdFor, planIdFor } = require('../../src/providers/ids');

describe('provider id resolution', () => {
  it('picks husmodata columns', () => {
    expect(serviceIdFor('husmodata', 'data', { id: 1 })).toBe(1);
    expect(serviceIdFor('husmodata', 'airtime', { id: 1 })).toBe(1);
    expect(serviceIdFor('husmodata', 'cable', { CableID: 2 })).toBe(2);
    expect(serviceIdFor('husmodata', 'electricity', { DiscoID: 3 })).toBe(3);
    expect(serviceIdFor('husmodata', 'epin', { examName: 'WAEC' })).toBe('WAEC');
    expect(planIdFor('husmodata', 'data', { dataId: 7 })).toBe(7);
    expect(planIdFor('husmodata', 'cable', { CableplanID: 9 })).toBe(9);
  });

  it('picks vtpass columns, and data and airtime differ for one network', () => {
    const mtn = { id: 1, vtpassDataServiceId: 'mtn-data', vtpassAirtimeServiceId: 'mtn' };
    expect(serviceIdFor('vtpass', 'data', mtn)).toBe('mtn-data');
    expect(serviceIdFor('vtpass', 'airtime', mtn)).toBe('mtn');
    expect(serviceIdFor('vtpass', 'cable', { vtpassServiceId: 'dstv' })).toBe('dstv');
    expect(serviceIdFor('vtpass', 'epin', { vtpassServiceId: 'waec' })).toBe('waec');
    expect(planIdFor('vtpass', 'data', { vtpassCode: 'mtn-10gb' })).toBe('mtn-10gb');
    expect(planIdFor('vtpass', 'cable', { vtpassCode: 'dstv-padi' })).toBe('dstv-padi');
  });

  it('throws naming the missing column rather than sending undefined upstream', () => {
    expect(() => serviceIdFor('vtpass', 'data', { id: 1 }))
      .toThrow(/vtpassDataServiceId/);
    expect(() => planIdFor('vtpass', 'data', { dataId: 7 }))
      .toThrow(/vtpassCode/);
  });

  it('treats an empty string as missing', () => {
    expect(() => serviceIdFor('vtpass', 'cable', { vtpassServiceId: '   ' }))
      .toThrow(/vtpassServiceId/);
  });

  it('rejects an unknown provider rather than guessing a column', () => {
    expect(() => serviceIdFor('nope', 'data', { id: 1 })).toThrow(/Unknown provider/);
  });

  it('throws when a service kind is not served by the provider', () => {
    expect(() => planIdFor('husmodata', 'electricity', { DiscoID: 3 }))
      .toThrow(/does not serve/);
  });

  it('rejects prototype-chain keys', () => {
    expect(() => serviceIdFor('toString', 'data', { id: 5 }))
      .toThrow(/Unknown provider/);
    expect(() => serviceIdFor('husmodata', 'toString', { id: 5 }))
      .toThrow(/does not serve/);
  });

  it('accepts 0 as a legitimate id', () => {
    expect(serviceIdFor('husmodata', 'data', { id: 0 })).toBe(0);
  });
});

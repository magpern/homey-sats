'use strict';

const Homey = require('homey');
const { Geocoder } = require('./lib/geo');

/**
 * Unofficial SATS app for Homey.
 * Each SATS member is a device of the "member" driver (see drivers/member).
 * The app itself only holds shared things: the centre geocoding cache, the
 * home location, and the app-level Flow cards. No credentials live at app level.
 */
class SatsApp extends Homey.App {
  async onInit() {
    // Cache of centre coordinates (public data only) in the app's settings store.
    this.geocoder = new Geocoder({
      cache: this.homey.settings,
      log: (...a) => this.log(...a),
    });

    this.homey.flow.getConditionCard('any_member_class_before')
      .registerRunListener(async (args) => this.getMembers()
        .some((device) => device.hasClassBefore({ time: args.time, day: args.day })));

    this.homey.flow.getActionCard('refresh_bookings')
      .registerRunListener(async () => {
        const members = this.getMembers();
        if (!members.length) throw new Error(this.homey.__('errors.no_members'));
        const results = await Promise.allSettled(members.map((d) => d.service.refresh({ reason: 'flow' })));
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length === results.length) throw failed[0].reason;
        return true;
      });

    this.log('SATS app started');
  }

  /** All paired SATS member devices. */
  getMembers() {
    try {
      return this.homey.drivers.getDriver('member').getDevices().filter((d) => d.service);
    } catch (e) {
      return [];
    }
  }

  /** Homey's own location (set in the Homey app), or null if unavailable. */
  getHomeLocation() {
    const lat = Number(this.homey.geolocation.getLatitude());
    const lon = Number(this.homey.geolocation.getLongitude());
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    return { lat, lon };
  }
}

module.exports = SatsApp;

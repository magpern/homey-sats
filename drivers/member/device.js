'use strict';

const Homey = require('homey');
const { MemberService } = require('../../lib/MemberService');
const { formatHHmm, localDateKey } = require('../../lib/time');

const RECONFIGURE_KEYS = ['market', 'path_segment', 'geocoding'];

/**
 * A paired SATS member. Holds only a refresh token in its store (no password).
 * All logic lives in lib/MemberService.js; this class wires it to Homey.
 */
class MemberDevice extends Homey.Device {
  async onInit() {
    this._settings = this.getSettings();
    const { driver } = this;
    this.service = new MemberService({
      store: {
        get: (k) => this.getStoreValue(k),
        set: (k, v) => {
          this.setStoreValue(k, v).catch(() => this.error(`Could not save ${k}`));
        },
      },
      getConfig: () => ({
        market: this._settings.market,
        pathSegment: this._settings.path_segment,
        geocoding: this._settings.geocoding !== false,
      }),
      getTimeZone: () => this.homey.clock.getTimezone(),
      getHome: () => this.homey.app.getHomeLocation(),
      geocoder: this.homey.app.geocoder,
      events: {
        onStart: (tokens, state) => driver.startsCard.trigger(this, tokens, state),
        onEnd: (tokens, state) => driver.endsCard.trigger(this, tokens, state),
        onCancelled: (tokens, state) => driver.cancelledCard.trigger(this, tokens, state),
      },
      getStartOffsets: () => driver.getStartOffsets(this),
      onStatus: (status) => this._onStatus(status).catch(() => {}),
      onBookings: (bookings) => this._onBookings(bookings).catch(() => {}),
      log: (...a) => this.log(...a),
      error: (...a) => this.error(...a),
      timers: {
        setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
        clearTimeout: (t) => this.homey.clearTimeout(t),
        setInterval: (fn, ms) => this.homey.setInterval(fn, ms),
        clearInterval: (t) => this.homey.clearInterval(t),
      },
    });
    this.service.start();
  }

  /** Called by the driver's repair flow after a successful login. */
  async setSession(refreshToken) {
    await this.setStoreValue('refreshToken', refreshToken);
    await this.setAvailable();
    this.service.reconfigure();
  }

  async onSettings({ newSettings, changedKeys }) {
    this._settings = newSettings;
    if (changedKeys.some((k) => RECONFIGURE_KEYS.includes(k))) {
      this.service.reconfigure();
    }
  }

  async _onStatus(status) {
    if (status.state === 'ok') {
      await this.setAvailable();
      await this.unsetWarning();
    } else if (status.state === 'auth_error') {
      await this.setUnavailable(this.homey.__('device.session_expired'));
    } else if (status.state === 'error') {
      await this.setWarning(status.message);
    }
  }

  async _onBookings(bookings) {
    const tz = this.homey.clock.getTimezone();
    const next = bookings.find((b) => !b.waitlisted && b.start > new Date());
    let text = this.homey.__('device.no_class');
    if (next) {
      const sameDay = localDateKey(next.start, tz) === localDateKey(new Date(), tz);
      const when = sameDay ? formatHHmm(next.start, tz) : `${localDateKey(next.start, tz)} ${formatHHmm(next.start, tz)}`;
      text = `${when} ${next.name}`;
    }
    await this.setCapabilityValue('sats_next_class', text);
    const centres = this.service.knownCentres().join(', ');
    if (centres !== this._settings.known_centres) {
      await this.setSettings({ known_centres: centres });
      this._settings = { ...this._settings, known_centres: centres };
    }
  }

  isWithinKm(km) {
    return this.service.isWithinKm(km);
  }

  isAtHomeCentre() {
    return this.service.isAtHomeCentre(this._settings.home_centres || '');
  }

  hasClassBefore(args) {
    return this.service.hasClassBefore(args);
  }

  async onDeleted() {
    this.service.stop();
  }

  async onUninit() {
    if (this.service) this.service.stop();
  }
}

module.exports = MemberDevice;

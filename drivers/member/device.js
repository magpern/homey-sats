'use strict';

const Homey = require('homey');
const { MemberService } = require('../../lib/MemberService');
const { formatNextClass, weekdayShort } = require('../../lib/present');
const { formatHHmm } = require('../../lib/time');

const RECONFIGURE_KEYS = ['market', 'path_segment', 'geocoding'];
const CAPABILITIES = ['next_class', 'next_waitlist_class', 'booked_count', 'waitlist_count', 'best_waitlist_position'];
const OLD_CAPABILITIES = ['sats_next_class'];

/**
 * A paired SATS member. Holds only a refresh token in its store (no password).
 * All logic lives in lib/MemberService.js; this class wires it to Homey.
 */
class MemberDevice extends Homey.Device {
  async onInit() {
    this._settings = this.getSettings();
    await this._migrateCapabilities();
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
        onCancelled: (tokens, state, booking) => {
          this._timeline('cancelled', tokens, booking);
          return driver.cancelledCard.trigger(this, tokens, state);
        },
        onPromoted: (tokens, state, booking) => {
          this._timeline('promoted', tokens, booking);
          return driver.promotedCard.trigger(this, tokens, state);
        },
        onPositionChanged: (tokens, state, booking) => {
          this._timeline('position', tokens, booking);
          return driver.positionCard.trigger(this, tokens, state);
        },
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
    // Show cached values right away, and keep counts current as classes pass.
    this._onBookings(this.service.bookings).catch(() => {});
    this._capTimer = this.homey.setInterval(() => this._updateCapabilities().catch(() => {}), 5 * 60 * 1000);
  }

  async _migrateCapabilities() {
    for (const cap of OLD_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(() => {});
    }
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => this.error(`Could not add ${cap}`));
    }
  }

  /** Post a change to the Homey timeline (if enabled in the app settings). */
  _timeline(kind, tokens, booking) {
    const tz = this.homey.clock.getTimezone();
    const when = `${weekdayShort(booking.start, tz, this.homey.i18n.getLanguage())} ${formatHHmm(booking.start, tz)}`;
    const text = this.homey.__(`timeline.${kind}`, {
      member: this.getName(),
      class: tokens.class_name,
      when,
      old: tokens.old_position,
      new: tokens.new_position,
    });
    this.homey.app.postTimeline(text).catch(() => {});
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

  async _onBookings() {
    await this._updateCapabilities();
    const centres = this.service.knownCentres().join(', ');
    if (centres !== this._settings.known_centres) {
      await this.setSettings({ known_centres: centres });
      this._settings = { ...this._settings, known_centres: centres };
    }
    this.homey.app.notifyBookingsChanged();
  }

  async _updateCapabilities() {
    const tz = this.homey.clock.getTimezone();
    const sum = this.service.summary();
    const next = sum.nextBooked
      ? formatNextClass(sum.nextBooked, tz, this.homey.i18n.getLanguage())
      : this.homey.__('device.no_class');
    const nextWaiting = sum.nextWaitlisted
      ? formatNextClass(sum.nextWaitlisted, tz, this.homey.i18n.getLanguage())
      : this.homey.__('device.no_waitlist_class');
    const values = {
      next_class: next,
      next_waitlist_class: nextWaiting,
      booked_count: sum.bookedCount,
      waitlist_count: sum.waitlistCount,
      best_waitlist_position: sum.bestWaitlistPosition, // null when not on any waiting list
    };
    for (const [cap, value] of Object.entries(values)) {
      if (this.hasCapability(cap) && this.getCapabilityValue(cap) !== value) {
        await this.setCapabilityValue(cap, value);
      }
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
    this._stop();
    this.homey.app.notifyBookingsChanged();
  }

  async onUninit() {
    this._stop();
  }

  _stop() {
    if (this._capTimer) this.homey.clearInterval(this._capTimer);
    if (this.service) this.service.stop();
  }
}

module.exports = MemberDevice;

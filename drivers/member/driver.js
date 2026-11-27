'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const { SatsClient, SatsAuthError } = require('../../lib/SatsClient');

/**
 * One device per SATS member. Pairing and repair use Homey's built-in
 * login_credentials view; the login is checked against SATS right there.
 * Only the resulting refresh token is stored (device store); the password is discarded.
 */
class MemberDriver extends Homey.Driver {
  async onInit() {
    this.startsCard = this.homey.flow.getDeviceTriggerCard('class_starts_in');
    this.startsCard.registerRunListener(async (args, state) => Number(args.minutes) === state.minutes);
    this.startsCard.on('update', () => {
      this._startArgs = null; // a Flow using the card changed: re-read the minute values
    });
    this.endsCard = this.homey.flow.getDeviceTriggerCard('class_ends');
    this.cancelledCard = this.homey.flow.getDeviceTriggerCard('class_cancelled');

    this.homey.flow.getConditionCard('class_within_km')
      .registerRunListener(async (args) => args.device.isWithinKm(args.km));
    this.homey.flow.getConditionCard('class_at_home_centre')
      .registerRunListener(async (args) => args.device.isAtHomeCentre());
  }

  /** Distinct "starts in N minutes" values used in Flows for this device. */
  async getStartOffsets(device) {
    if (!this._startArgs) this._startArgs = await this.startsCard.getArgumentValues();
    const id = device.getData().id;
    return [...new Set(this._startArgs
      .filter((a) => a.device && a.device.getData && a.device.getData().id === id)
      .map((a) => Number(a.minutes))
      .filter((n) => Number.isFinite(n) && n >= 0))];
  }

  /** Log in and translate failures into messages the pairing view shows. */
  async _login(username, password) {
    const client = new SatsClient({});
    try {
      return await client.login(username, password);
    } catch (err) {
      if (err instanceof SatsAuthError) throw new Error(this.homey.__('pair.invalid_credentials'));
      if (err.code === 'RATE_LIMIT') throw new Error(this.homey.__('pair.rate_limited'));
      if (err.code === 'NETWORK') throw new Error(this.homey.__('pair.unreachable'));
      throw new Error(this.homey.__('pair.failed', { message: err.message }));
    }
  }

  async onPair(session) {
    let account = null;

    session.setHandler('login', async ({ username, password }) => {
      account = await this._login(username, password); // throws a readable error on failure
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!account) throw new Error(this.homey.__('pair.not_logged_in'));
      return [{
        name: this.homey.__('pair.device_name'),
        data: { id: account.memberKey || crypto.randomBytes(12).toString('hex') },
        store: { refreshToken: account.refreshToken, idFromMember: Boolean(account.memberKey) },
      }];
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      const account = await this._login(username, password);
      // Refuse to attach another member's login to this device (only checkable when
      // the device id was derived from the member's identity at pairing time).
      if (device.getStoreValue('idFromMember') && account.memberKey && account.memberKey !== device.getData().id) {
        throw new Error(this.homey.__('pair.other_member'));
      }
      await device.setSession(account.refreshToken);
      return true;
    });
  }
}

module.exports = MemberDriver;

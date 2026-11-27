'use strict';

/* Widget API: returns the widget data model (lib/present.js). No tokens or credentials. */
module.exports = {
  async getClasses({ homey, query }) {
    const awayKm = Number(query.awayKm);
    return homey.app.getWidgetData({
      member: query.member || 'all',
      awayKm: Number.isFinite(awayKm) && awayKm >= 0 ? awayKm : 10,
    });
  },
};

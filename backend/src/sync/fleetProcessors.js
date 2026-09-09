/* ============================================================================
   FLEET SYNC PROCESSORS
   Thin adapters over the fleet SERVICE layer. All rules (odometer
   monotonicity, active-trip detection, dim_date guards, transactions) live
   in services/fleetService.js - these adapters only translate queue context
   into service calls with conflictAsError=true so violations park as
   CONFLICT rows instead of HTTP 409s.

   conflictOverride (set by the conflict resolution service on
   CLIENT_WINS/MERGED re-apply) deliberately bypasses the violated guard:
   the human resolution IS the authority that the client's version wins.

   This is the drift-elimination core: the online fleet routes and these
   processors literally execute the same service functions.
   ============================================================================ */

const fleetService = require('../services/fleetService');

async function processVehicleCheck(actor, p) {
  const { checkKey } = await fleetService.recordVehicleCheck(actor, p);
  return checkKey;
}

async function processTripStart(actor, p) {
  const { tripKey } = await fleetService.startTrip(actor, p, {
    conflictAsError: true,
    conflictOverride: actor.conflictOverride === true
  });
  return tripKey;
}

async function processTripEnd(actor, p) {
  const { tripKey, alreadyEnded } = await fleetService.endTrip(actor, p, {
    conflictAsError: true,
    conflictOverride: actor.conflictOverride === true
  });
  if (alreadyEnded) return null; // idempotent duplicate ack
  return tripKey;
}

async function processFuelRequest(actor, p) {
  const { fuelRequestKey } = await fleetService.createFuelRequest(actor, p);
  return fuelRequestKey;
}

async function processFuelLog(actor, p) {
  const { fuelLogKey } = await fleetService.recordFuelLog(actor, p, {
    conflictAsError: true,
    conflictOverride: actor.conflictOverride === true
  });
  return fuelLogKey;
}

async function processMaintenance(actor, p) {
  const { maintenanceKey } = await fleetService.reportMaintenance(actor, p);
  return maintenanceKey;
}

module.exports = {
  processVehicleCheck,
  processTripStart,
  processTripEnd,
  processFuelRequest,
  processFuelLog,
  processMaintenance
};

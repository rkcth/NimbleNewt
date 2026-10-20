/**
 * Loaded with `node --import` by scripts/postgres-versions.mjs when the suites are run against PostgreSQL 14 to 16 (card F04g): lowers the
 * adapter's version floor to the one named in NIMBLENEWT_QUALIFY_PG_FLOOR (for example 140000). Without that variable it does nothing,
 * and the normal suites never load it.
 */
import { lowerServerFloorForVerification } from "../storage.js";

const floor = process.env["NIMBLENEWT_QUALIFY_PG_FLOOR"];
if (floor !== undefined && floor !== "") lowerServerFloorForVerification(Number(floor));

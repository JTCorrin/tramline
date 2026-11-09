import { settings } from '../settings.server';
import { AsnData } from './asn';

/** The install's IP-to-network table, refreshed by the minute job (see hooks.server.ts). */
export const asnData = new AsnData(settings.dataDir, settings.traffic?.asnUrl ?? null);

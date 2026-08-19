/**
 * Which Slack channel a follow-up case belongs in.
 *
 * A suggestion, never a decision. The supervisor sees the proposed channel and
 * the sentence explaining it, and can pick something else — routing a blockage
 * to the wrong contractor wastes a week, and the person raising the case knows
 * things the rules do not.
 *
 * The table lives in config/slack-routing.json so contracts and reorganisations
 * do not require a deployment. See that file for the rule order.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LineString } from '../../cfpi/src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the table lives.
 *
 * Overridable so the tests can exercise a rich fixture while the deployed table
 * stays small. Without the seam they are the same file, and every trim to the
 * real routing — the thing that changes most — breaks tests that were never
 * about it.
 */
const configPath = () =>
  process.env.SLACK_ROUTING_CONFIG
    ? resolve(process.env.SLACK_ROUTING_CONFIG)
    : resolve(here, '../config/slack-routing.json');

interface Party {
  label: string;
  channel: string;
  aliases: string[];
}

interface Zone {
  label: string;
  channel: string;
  lat: number;
  lon: number;
}

interface RoutingConfig {
  default_channel: string;
  escalation_channel: string;
  escalate_above_severity: number;
  parties: Party[];
  zones: Zone[];
}

export interface ChannelOption {
  channel: string;
  reason: string;
}

export interface ChannelSuggestion extends ChannelOption {
  /**
   * How much the supervisor should trust it.
   *
   * `high` means they named a party we recognise. `medium` means we guessed from
   * where the drain is. `low` means we fell through to the catch-all and someone
   * should look. Shown in the console, because a suggestion that cannot say how
   * sure it is invites the supervisor to accept all of them without reading.
   */
  confidence: 'high' | 'medium' | 'low';
  alternatives: ChannelOption[];
}

/**
 * Used when the table is missing or unreadable.
 *
 * No channels: a broken routing table must not start posting cases to a guessed
 * channel name. Everything still gets recorded in FRCDE, which is where the case
 * lives anyway, and the console says plainly that nobody outside was told.
 */
const FALLBACK: RoutingConfig = {
  default_channel: '',
  escalation_channel: '',
  escalate_above_severity: 4,
  parties: [],
  zones: [],
};

let cache: RoutingConfig | null = null;

export function routingConfig(): RoutingConfig {
  if (cache) return cache;
  try {
    const path = configPath();
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RoutingConfig>;
    cache = {
      ...FALLBACK,
      ...raw,
      default_channel: raw.default_channel ?? '',
      escalation_channel: raw.escalation_channel ?? '',
      parties: raw.parties ?? [],
      zones: raw.zones ?? [],
    };
  } catch (e) {
    // A broken routing table must not stop follow-ups being raised. They are
    // recorded without a Slack case, which is visibly different from being
    // routed — and far better than the console refusing to route at all.
    console.warn('[routing] no usable table, cases will not be posted:', (e as Error).message);
    cache = { ...FALLBACK };
  }
  return cache;
}

/** Test seam — also picks up an edited config without a restart. */
export function reloadRouting(): void {
  cache = null;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Does `text` mention this alias as whole words?
 *
 * Substring matching is wrong here: the alias `pub` would match "Republic
 * Plaza", and `road` would match "Broadway". Both would route a case to a party
 * with no idea it was coming.
 */
function mentions(text: string, alias: string): boolean {
  const haystack = ` ${normalise(text)} `;
  const needle = ` ${normalise(alias)} `;
  return haystack.includes(needle);
}

function matchParty(assignedTo: string, parties: Party[]): Party | null {
  let best: { party: Party; length: number } | null = null;
  for (const p of parties) {
    for (const alias of p.aliases) {
      if (!mentions(assignedTo, alias)) continue;
      // Longest alias wins: "ang mo kio town council" should beat a bare
      // "town council" rule if both are present.
      const length = normalise(alias).length;
      if (!best || length > best.length) best = { party: p, length };
    }
  }
  return best?.party ?? null;
}

/** Rough centre of a drain. Good enough to place it in a zone. */
function centroid(geometry: LineString): { lat: number; lon: number } | null {
  const cs = geometry?.coordinates;
  if (!Array.isArray(cs) || cs.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of cs) {
    lon += x;
    lat += y;
  }
  return { lat: lat / cs.length, lon: lon / cs.length };
}

function nearestZone(at: { lat: number; lon: number }, zones: Zone[]): Zone | null {
  let best: { zone: Zone; d: number } | null = null;
  for (const z of zones) {
    // Squared planar distance. Over Singapore the projection error is far below
    // the distance between zone centres, and this is only picking a nearest.
    const dLat = z.lat - at.lat;
    const dLon = (z.lon - at.lon) * Math.cos((at.lat * Math.PI) / 180);
    const d = dLat * dLat + dLon * dLon;
    if (!best || d < best.d) best = { zone: z, d };
  }
  return best?.zone ?? null;
}

export interface SuggestInput {
  assigned_to: string;
  severity: number;
  geometry?: LineString | null;
  asset_name?: string;
}

/**
 * Propose a channel, and say why.
 *
 * The reason is not decoration. A supervisor who cannot see why a case is about
 * to be posted to `#fu-nea` cannot tell a good suggestion from a coincidence.
 */
export function suggestChannel(input: SuggestInput): ChannelSuggestion {
  const cfg = routingConfig();
  const alternatives: ChannelOption[] = [];

  const party = matchParty(input.assigned_to ?? '', cfg.parties);
  const at = input.geometry ? centroid(input.geometry) : null;
  const zone = at ? nearestZone(at, cfg.zones) : null;

  let primary: ChannelOption;
  let confidence: ChannelSuggestion['confidence'];

  if (party) {
    primary = {
      channel: party.channel,
      reason: `Routed to ${party.label}, matched from "${input.assigned_to}".`,
    };
    confidence = 'high';
    if (zone) {
      alternatives.push({
        channel: zone.channel,
        reason: `${zone.label} zone, by where the drain is.`,
      });
    }
  } else if (zone) {
    primary = {
      channel: zone.channel,
      reason:
        `No known party in "${input.assigned_to}", so routed by location — ` +
        `${input.asset_name ?? 'this drain'} sits in the ${zone.label} zone.`,
    };
    confidence = 'medium';
  } else if (cfg.default_channel) {
    primary = {
      channel: cfg.default_channel,
      reason: 'Nothing to match on — neither a known party nor a location.',
    };
    confidence = 'low';
  } else {
    // No catch-all configured. Proposing a channel that does not exist would
    // fail at `chat.postMessage` with `channel_not_found`, long after the
    // supervisor stopped looking — better to say plainly that this one is not
    // going anywhere.
    primary = {
      channel: '',
      reason:
        'No channel matches, and there is no catch-all configured. ' +
        'The follow-up will be recorded in FRCDE only.',
    };
    confidence = 'low';
  }

  // Severity escalates *in addition*, never instead: the work still goes to
  // whoever does the work.
  if (
    cfg.escalation_channel &&
    Number(input.severity) >= cfg.escalate_above_severity &&
    primary.channel !== cfg.escalation_channel
  ) {
    alternatives.push({
      channel: cfg.escalation_channel,
      reason: `Severity ${input.severity} — worth flagging here as well.`,
    });
  }

  if (cfg.default_channel && primary.channel !== cfg.default_channel) {
    alternatives.push({ channel: cfg.default_channel, reason: 'General follow-ups.' });
  }

  return { ...primary, confidence, alternatives: dedupe(alternatives, primary.channel) };
}

function dedupe(options: ChannelOption[], exclude: string): ChannelOption[] {
  const seen = new Set([exclude]);
  const out: ChannelOption[] = [];
  for (const o of options) {
    if (seen.has(o.channel)) continue;
    seen.add(o.channel);
    out.push(o);
  }
  return out;
}

/** Every channel the table knows about — the console's override list. */
export function knownChannels(): string[] {
  const cfg = routingConfig();
  return [
    ...new Set(
      [
        cfg.default_channel,
        cfg.escalation_channel,
        ...cfg.parties.map((p) => p.channel),
        ...cfg.zones.map((z) => z.channel),
      ].filter(Boolean),
    ),
  ].sort();
}

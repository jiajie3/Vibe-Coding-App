/**
 * Routing tests.
 *
 * The failure that matters here is a confident wrong answer: a case posted to a
 * channel the supervisor did not read carefully, watched by people who are not
 * responsible for that drain. So these check what it matches, and just as much
 * what it refuses to match.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { knownChannels, reloadRouting, routingConfig, suggestChannel } from './routing.ts';
import type { LineString } from '../../cfpi/src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Exercised against a fixture, not the deployed table.
 *
 * The real config is deployment data — which channels exist in one workspace —
 * and it changes whenever a contract does. Pointing the tests at it means every
 * such edit breaks assertions that were never about routing behaviour. The
 * fixture keeps a rich table of parties and zones so the rules stay covered
 * whatever the live table has been trimmed to.
 */
process.env.SLACK_ROUTING_CONFIG = resolve(here, 'routing.fixture.json');
reloadRouting();
const jobs = JSON.parse(
  readFileSync(resolve(here, '../../contracts/examples/seed-jobs.json'), 'utf8'),
) as { asset: { name: string; geometry: LineString } }[];

/** A LineString sitting at one point — enough to place it in a zone. */
const at = (lat: number, lon: number): LineString => ({
  type: 'LineString',
  coordinates: [
    [lon, lat],
    [lon + 0.001, lat + 0.001],
  ],
});

test('a named party wins, and says so', () => {
  const s = suggestChannel({ assigned_to: 'Ang Mo Kio Town Council', severity: 3 });
  assert.equal(s.channel, '#fu-amk-town-council');
  assert.equal(s.confidence, 'high');
  assert.match(s.reason, /Ang Mo Kio Town Council/);
});

test('party matching ignores case, punctuation and surrounding words', () => {
  for (const text of ['AMK TC', 'amk-tc', 'Pass to AMK TC please', 'ang mo kio tc']) {
    assert.equal(
      suggestChannel({ assigned_to: text, severity: 3 }).channel,
      '#fu-amk-town-council',
      `failed on: ${text}`,
    );
  }
});

test('an alias never matches inside a longer word', () => {
  // `pub` must not match "Republic", `road` must not match "Broadway". Both
  // would post a case to a party with no idea it was coming.
  const a = suggestChannel({ assigned_to: 'Republic Plaza management', severity: 2 });
  assert.notEqual(a.channel, '#fu-pub-catchment');

  const b = suggestChannel({ assigned_to: 'Broadway Cleaning Services', severity: 2 });
  assert.notEqual(b.channel, '#fu-lta');
});

test('the longest matching alias wins', () => {
  // Both "contractor" and "desilting" are aliases of the same party here; the
  // point is that a more specific phrase is not beaten by a vaguer one.
  const s = suggestChannel({ assigned_to: 'Ang Mo Kio Town Council contractor', severity: 3 });
  assert.equal(s.channel, '#fu-amk-town-council');
});

test('with no known party, it routes by where the drain is', () => {
  const s = suggestChannel({
    assigned_to: 'Rajesh Kumar',
    severity: 2,
    geometry: at(1.4382, 103.7891), // Woodlands
    asset_name: 'Sungei Mandai',
  });
  assert.equal(s.channel, '#fu-zone-north');
  assert.equal(s.confidence, 'medium');
  assert.match(s.reason, /North zone/);
});

test('each zone centroid resolves to its own channel', () => {
  const cfg = routingConfig();
  for (const z of cfg.zones) {
    const s = suggestChannel({
      assigned_to: 'someone unknown',
      severity: 1,
      geometry: at(z.lat, z.lon),
    });
    assert.equal(s.channel, z.channel, `${z.label} routed to ${s.channel}`);
  }
});

test('with nothing to go on it falls through, and admits it', () => {
  const s = suggestChannel({ assigned_to: 'Rajesh Kumar', severity: 2 });
  assert.equal(s.channel, '#drain-followups');
  assert.equal(s.confidence, 'low');
});

test('severity adds an escalation channel rather than hijacking the routing', () => {
  const s = suggestChannel({ assigned_to: 'Tampines Town Council', severity: 5 });
  // The work still goes to whoever does the work.
  assert.equal(s.channel, '#fu-tampines-town-council');
  assert.ok(
    s.alternatives.some((a) => a.channel === '#flood-response'),
    'escalation channel should be offered alongside',
  );
});

test('a low-severity case is not escalated', () => {
  const s = suggestChannel({ assigned_to: 'Tampines Town Council', severity: 2 });
  assert.ok(!s.alternatives.some((a) => a.channel === '#flood-response'));
});

test('alternatives never repeat the primary channel', () => {
  for (const assigned of ['PUB catchment', 'nobody in particular', 'NEA vector control']) {
    const s = suggestChannel({ assigned_to: assigned, severity: 5 });
    assert.ok(
      !s.alternatives.some((a) => a.channel === s.channel),
      `${assigned}: primary repeated in alternatives`,
    );
    const channels = s.alternatives.map((a) => a.channel);
    assert.equal(new Set(channels).size, channels.length, `${assigned}: duplicate alternatives`);
  }
});

test('every suggestion carries a reason a supervisor can act on', () => {
  for (const assigned of ['AMK TC', 'Rajesh Kumar', '']) {
    const s = suggestChannel({ assigned_to: assigned, severity: 3, geometry: at(1.32, 103.84) });
    assert.ok(s.reason.length > 20, `thin reason for "${assigned}": ${s.reason}`);
    assert.ok(s.channel.startsWith('#'), 'channel should be a Slack channel name');
  }
});

test('every real seed drain routes somewhere valid', () => {
  const valid = new Set(knownChannels());
  for (const j of jobs) {
    const s = suggestChannel({
      assigned_to: 'unassigned',
      severity: 3,
      geometry: j.asset.geometry,
      asset_name: j.asset.name,
    });
    assert.ok(valid.has(s.channel), `${j.asset.name} → unknown channel ${s.channel}`);
  }
});

test('malformed geometry degrades to the catch-all instead of throwing', () => {
  const empty = { type: 'LineString', coordinates: [] } as LineString;
  const s = suggestChannel({ assigned_to: 'nobody', severity: 3, geometry: empty });
  assert.equal(s.channel, '#drain-followups');
});

/* ------------------------------- a table with no catch-all configured */

test('with no catch-all, an unmatched follow-up is not routed anywhere', () => {
  // The shape the deployed table has while only a couple of channels exist.
  // Proposing a channel that does not exist would fail at post time with
  // `channel_not_found`, long after the supervisor stopped looking.
  process.env.SLACK_ROUTING_CONFIG = resolve(here, 'routing.minimal.fixture.json');
  reloadRouting();
  try {
    const matched = suggestChannel({ assigned_to: 'Party A crew', severity: 3 });
    assert.equal(matched.channel, '#fixture-party-a');
    assert.equal(matched.confidence, 'high');

    const unmatched = suggestChannel({ assigned_to: 'Rajesh Kumar', severity: 3 });
    assert.equal(unmatched.channel, '', 'should decline to route rather than invent one');
    assert.equal(unmatched.confidence, 'low');
    assert.match(unmatched.reason, /recorded in FRCDE only/);

    // And nothing empty leaks into the console override list or alternatives.
    assert.ok(!knownChannels().includes(''), 'empty channel in the picker');
    const high = suggestChannel({ assigned_to: 'Party B', severity: 5 });
    assert.ok(
      !high.alternatives.some((a) => a.channel === ''),
      'an unconfigured escalation channel was offered',
    );
  } finally {
    process.env.SLACK_ROUTING_CONFIG = resolve(here, 'routing.fixture.json');
    reloadRouting();
  }
});

test('an unreadable table declines to route rather than guessing', () => {
  process.env.SLACK_ROUTING_CONFIG = resolve(here, 'does-not-exist.json');
  reloadRouting();
  try {
    const s = suggestChannel({ assigned_to: 'Party A', severity: 5 });
    assert.equal(s.channel, '', 'a broken table must not post to a guessed channel');
    assert.deepEqual(knownChannels(), []);
  } finally {
    process.env.SLACK_ROUTING_CONFIG = resolve(here, 'routing.fixture.json');
    reloadRouting();
  }
});

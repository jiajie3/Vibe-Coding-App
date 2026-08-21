/**
 * Photo pipeline (contract §7).
 *
 * Raw capture → resize → persist → hash → session record.
 *
 * The resize is not cosmetic. A modern phone shoots ~5 MB per frame; thirty of
 * those on one inspection is 150 MB of an inspector's mobile data. At 1600 px /
 * quality 0.8 a defect photo lands around 300–600 KB and loses nothing that
 * matters for assessing silt depth or cracking.
 */

import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { uuidv7 } from '../core/uuid.ts';
import { getController } from '../state/activeInspection.ts';
import { addPhoto, getSession, setPosition } from '../state/session.ts';
import { getCurrentLocation } from './locationTask.ts';
import type { PhotoRecord } from '../state/session.ts';
import { enqueue } from './outbox.ts';

const MAX_EDGE = 1600;
const QUALITY = 0.8;
const DIR_NAME = 'inspection-photos';

/**
 * How old the walk's last fix may be before it stops standing in for a photo's
 * own position.
 *
 * Thirty seconds of walking is perhaps forty metres. Beyond that the fallback
 * stops being an approximation and starts being a different place.
 */
export const STALE_FIX_MS = 30_000;

/**
 * Where the photograph is being taken.
 *
 * The walk's own position first, and only while it is fresh. That position has
 * been through the coverage tracker — checked for accuracy, checked against the
 * corridor, already projected onto the alignment — so it is both the best
 * answer available and the one consistent with the coverage the same walk is
 * reporting. It is also the only answer that works under Simulate, where the
 * drain is being walked in software and the handset is sitting on a desk
 * several kilometres away.
 *
 * Asking the device instead was tried and is wrong for exactly that reason: it
 * answered with the desk, which is off the corridor, so the projection refused
 * it and the photograph came out "off the drain".
 *
 * The one-shot fix is the fallback, for when the walk has no recent position of
 * its own — the tracker only *accepts* a fix that is accurate enough and inside
 * the corridor, so between two accepted fixes, and before the first one, there
 * is nothing to inherit. That was the original bug: two photographs at two
 * places, one of them with no position at all.
 *
 * If neither answers, the photograph is filed with no position. Honest and
 * visibly missing beats quietly wrong.
 */
async function positionNow(): Promise<{
  lat: number;
  lon: number;
  chainage_m: number | null;
} | null> {
  const last = getSession().last_position;
  if (last && Date.now() - Date.parse(last.at) <= STALE_FIX_MS) return last;

  const fix = await getCurrentLocation();
  if (!fix) return null;

  const at = {
    lat: fix.lat,
    lon: fix.lon,
    chainage_m: getController()?.chainageAt(fix.lat, fix.lon) ?? null,
  };
  // The map and the camera overlay both read this, so a photograph taken while
  // the walk was between fixes still moves the displayed distance.
  setPosition(at.lat, at.lon, at.chainage_m);
  return at;
}

function photoDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Process a photo and attach it to the current session.
 *
 * `fieldId` is the checklist section the photograph belongs to — the template's
 * photo field.
 *
 * Every photograph is a live capture, placed at the inspector's current position
 * and at their distance along the drain. Picking one from the camera roll used
 * to be allowed and no longer is: such a picture proves nothing about where or
 * when it was taken, and everyone downstream — the reviewer, the automated
 * check, the contractor sent to the spot — had to carry that doubt. Removing
 * the option is what makes a photograph here evidence rather than an image.
 */
export async function processCapture(
  rawUri: string,
  opts: {
    fieldId?: string | null;
    caption?: string;
  } = {},
): Promise<PhotoRecord> {
  const id = uuidv7();

  // Resize. `height: null` preserves aspect ratio.
  const ctx = ImageManipulator.manipulate(rawUri);
  ctx.resize({ width: MAX_EDGE, height: null });
  const rendered = await ctx.renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: QUALITY,
  });

  // saveAsync writes to the cache directory, which the OS may evict at any time.
  // An inspection can sit in the outbox for hours, so move it somewhere durable.
  let file = new File(saved.uri);
  try {
    const target = new File(photoDir(), `${id}.jpg`);
    file.move(target);
    file = target;
  } catch {
    // Keep the cache copy rather than losing the photo outright.
  }

  // Integrity check so a truncated upload is detected rather than silently
  // stored as a corrupt file. Note this hashes the base64 *encoding*, not the
  // raw bytes — FRCDE must verify the same way for the comparison to hold.
  const base64 = await file.base64();
  const sha256 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    base64,
  );

  // Here and now. Null when the phone has no fix, never borrowed from
  // somewhere else: a coordinate that was guessed is worse than one that is
  // missing, because nothing downstream can tell the two apart.
  const pos = await positionNow();
  const lat = pos?.lat ?? null;
  const lon = pos?.lon ?? null;
  const chainage = pos?.chainage_m ?? null;

  const record: PhotoRecord = {
    id,
    uri: file.uri,
    field_id: opts.fieldId ?? null,
    captured_at: new Date().toISOString(),
    lat,
    lon,
    chainage_m: chainage,
    sha256,
    byte_size: file.size ?? 0,
    caption: opts.caption,
  };

  addPhoto(record);

  // Queue the three-step upload (presign → PUT → confirm) immediately rather
  // than at submission. Photos are the bulk of an inspection's bytes, so
  // trickling them up during the walk means the final submit is near-instant
  // instead of a five-minute wait beside the van.
  const session = getSession();
  if (session.inspection_id && session.job) {
    enqueue('attachment', session.job.id, session.inspection_id, {
      id: record.id,
      uri: record.uri,
      byte_size: record.byte_size,
      sha256: record.sha256,
      meta: {
        kind: opts.fieldId ? 'defect' : 'context',
        // Always, now. FRCDE keeps the field for records made before the
        // camera roll was taken away.
        source: 'camera',
        captured_at: record.captured_at,
        location:
          record.lat != null && record.lon != null
            ? { lat: record.lat, lon: record.lon }
            : undefined,
        chainage_m: record.chainage_m,
        checklist_field_id: record.field_id,
        caption: record.caption,
        sha256: record.sha256,
        byte_size: record.byte_size,
      },
    });
  }

  return record;
}

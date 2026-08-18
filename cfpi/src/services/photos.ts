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
import { addPhoto, getSession } from '../state/session.ts';
import type { PhotoRecord, PhotoSource } from '../state/session.ts';
import { enqueue } from './outbox.ts';

const MAX_EDGE = 1600;
const QUALITY = 0.8;
const DIR_NAME = 'inspection-photos';

function photoDir(): Directory {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * EXIF varies by platform and camera; read defensively.
 *
 * `DateTimeOriginal` is "YYYY:MM:DD HH:MM:SS", which Date cannot parse — the
 * colons in the date part have to become dashes first.
 */
function exifTaken(exif: Record<string, unknown> | undefined): string | null {
  const raw = exif?.DateTimeOriginal ?? exif?.DateTime;
  if (typeof raw !== 'string') return null;
  const iso = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function exifLocation(
  exif: Record<string, unknown> | undefined,
): { lat: number; lon: number } | null {
  const lat = Number(exif?.GPSLatitude);
  const lon = Number(exif?.GPSLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  // Hemisphere refs are separate tags; without applying them a photo in the
  // southern hemisphere lands in the northern one.
  const latRef = String(exif?.GPSLatitudeRef ?? 'N').toUpperCase();
  const lonRef = String(exif?.GPSLongitudeRef ?? 'E').toUpperCase();
  return {
    lat: latRef === 'S' ? -Math.abs(lat) : Math.abs(lat),
    lon: lonRef === 'W' ? -Math.abs(lon) : Math.abs(lon),
  };
}

/**
 * Process a photo and attach it to the current session.
 *
 * `fieldId` links the photo to the checklist question that demanded it, so
 * validation can tell "blockage present: yes" has its mandatory evidence.
 *
 * A live capture is placed at the inspector's current position. A photo from the
 * album was taken somewhere else at some other time, so its own EXIF is used —
 * and if it has none, the position is left null rather than inventing one from
 * wherever the phone happens to be standing.
 */
export async function processCapture(
  rawUri: string,
  opts: {
    fieldId?: string | null;
    caption?: string;
    source?: PhotoSource;
    exif?: Record<string, unknown>;
  } = {},
): Promise<PhotoRecord> {
  const id = uuidv7();
  const source: PhotoSource = opts.source ?? 'camera';

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

  const pos = getSession().last_position;
  const fromLibrary = source === 'library';

  // A live capture is here and now. A library photo speaks for itself or not at
  // all — borrowing the inspector's current position would file it at a place it
  // was never taken, which is exactly the kind of quiet inaccuracy that makes an
  // evidence record worthless.
  const exifPos = fromLibrary ? exifLocation(opts.exif) : null;
  const lat = fromLibrary ? (exifPos?.lat ?? null) : (pos?.lat ?? null);
  const lon = fromLibrary ? (exifPos?.lon ?? null) : (pos?.lon ?? null);

  const chainage = fromLibrary
    ? exifPos
      ? getController()?.chainageAt(exifPos.lat, exifPos.lon) ?? null
      : null
    : (pos?.chainage_m ?? null);

  const record: PhotoRecord = {
    id,
    uri: file.uri,
    source,
    field_id: opts.fieldId ?? null,
    captured_at:
      (fromLibrary ? exifTaken(opts.exif) : null) ?? new Date().toISOString(),
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
        source: record.source,
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

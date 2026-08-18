/**
 * Types mirroring the CFPI <-> FRCDE contract (docs/api-contract.md).
 * Keep field names byte-identical to the API — no camelCase translation layer.
 */

export type JobStatus =
  | 'available'
  | 'accepted'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type AssetType =
  | 'open_concrete_drain'
  | 'closed_box_culvert'
  | 'roadside_scupper'
  | 'canal'
  | 'earth_drain';

/** GeoJSON RFC 7946. Coordinates are [longitude, latitude] — see the gotcha in §4. */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface InspectionRules {
  segment_length_m: number;
  corridor_tolerance_m: number;
  max_accuracy_m: number;
  min_coverage_pct: number;
  max_speed_mps: number;
  allow_override: boolean;
  require_photo_on_override: boolean;
  /**
   * Maximum gap between two consecutive fixes that may still be treated as
   * "walked through". Not in the v1 API payload — a client-side constant with a
   * server-overridable default. See CoverageTracker for why this matters.
   */
  max_bridge_m?: number;
}

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  length_m: number;
  geometry: LineString;
  segment_boundaries_m: number[];
  /**
   * Stretches where GPS cannot verify coverage — tunnelled or culverted runs.
   *
   * Roughly 40% of Singapore's mapped drains are underground. Without this the
   * app is unusable on them: every fix is rejected as `poor_accuracy` or
   * `outside_corridor`, coverage stalls, and an inspector who did everything
   * right fails the completion gate. The bridge cap makes it worse, since it is
   * designed to refuse credit for exactly that kind of gap.
   *
   * Excluded stretches are removed from the coverage denominator, so 100% means
   * "all the surface stretches" — which is the only thing GPS can honestly
   * attest to. Chainage ranges, same units as `segment_boundaries_m`.
   */
  excluded_ranges_m?: [number, number][];
  access_notes?: string;
  hazards?: string[];
}

export interface Job {
  id: string;
  reference: string;
  status: JobStatus;
  version: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_at: string;
  assigned_inspector_id: string | null;
  asset: Asset;
  inspection_rules: InspectionRules;
  checklist_template: { id: string; version: number };
  rejection_reason: string | null;
  updated_at: string;
}

/** A raw GPS fix as delivered by expo-location, before any filtering. */
export interface Fix {
  lat: number;
  lon: number;
  /** Horizontal accuracy in metres. Missing is treated as unusable. */
  acc?: number;
  alt?: number;
  /** Speed in m/s as reported by the OS, when available. */
  spd?: number;
  hdg?: number;
  /** Device clock at the time of the fix, ISO 8601 UTC. */
  t: string;
  mock?: boolean;
  src?: 'gps' | 'fused' | 'network';
}

/** A fix that survived filtering, ready for the outbox. */
export interface TrackPoint extends Fix {
  seq: number;
}

export type RejectReason =
  | 'no_accuracy'
  | 'poor_accuracy'
  | 'outside_corridor'
  | 'duplicate';

export interface FixResult {
  accepted: boolean;
  reason?: RejectReason;
  /** Distance along the drain centreline, metres. */
  chainage_m?: number;
  /** Perpendicular offset from the centreline, metres. */
  offset_m?: number;
  /** Segment indices newly marked covered by this fix. Drives the map repaint. */
  newly_covered: number[];
  coverage_pct: number;
  flags: CoverageFlag[];
}

export type CoverageFlag =
  | 'mock_location'
  | 'implausible_speed'
  | 'large_gap_bridged'
  | 'override_used';

// ------------------------------------------------------------- checklists

export type ChecklistFieldType =
  | 'boolean'
  | 'single_select'
  | 'multi_select'
  | 'number'
  | 'text'
  | 'photo'
  | 'signature'
  | 'severity';

export interface ChecklistOption {
  value: string;
  label: string;
}

/** A condition evaluated against another field's current answer. */
export interface FieldCondition {
  field?: string;
  equals?: unknown;
  in?: unknown[];
}

export interface ChecklistField {
  id: string;
  section_id?: string;
  type: ChecklistFieldType;
  label: string;
  help_text?: string;
  required?: boolean;
  options?: ChecklistOption[];
  min?: number;
  max?: number;
  unit?: string;
  /** Field is hidden unless this condition holds. */
  visible_if?: FieldCondition;
  /** Photo capture becomes mandatory when this condition holds on this field. */
  requires_photo_when?: FieldCondition;
}

export interface ChecklistSection {
  id: string;
  title: string;
}

export interface ChecklistTemplate {
  id: string;
  version: number;
  title: string;
  published_at?: string;
  sections?: ChecklistSection[];
  fields: ChecklistField[];
}

export type AnswerValue = string | number | boolean | string[] | null | undefined;
export type Answers = Record<string, AnswerValue>;

export interface ValidationError {
  field_id: string;
  label: string;
  code: 'required' | 'photo_required' | 'out_of_range' | 'too_few_photos';
  message: string;
}

export interface CoverageSummary {
  client_computed_pct: number;
  covered_segments: number;
  total_segments: number;
  uncovered_ranges_m: [number, number][];
}

/**
 * Checklist form engine.
 *
 * FRCDE serves the checklist as a versioned JSON schema and CFPI renders it
 * dynamically (contract §6). That means changing a question is a config change,
 * not an app-store release with a two-week review — which matters when a drainage
 * standard is revised and 40 inspectors are already in the field.
 *
 * Pure logic, no React: visibility, photo requirements and validation are all
 * decidable from (template, answers) alone, so they can be tested exhaustively.
 */

import type {
  Answers,
  AnswerValue,
  ChecklistField,
  ChecklistTemplate,
  FieldCondition,
  ValidationError,
} from './types.ts';

function isBlank(v: AnswerValue): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Evaluate a condition against the current answers.
 *
 * `field` is optional: on `requires_photo_when` the condition applies to the
 * field that declares it, so the caller supplies the value directly.
 */
function matches(cond: FieldCondition | undefined, value: AnswerValue): boolean {
  if (!cond) return false;
  if (cond.in !== undefined) {
    if (Array.isArray(value)) return value.some((v) => cond.in!.includes(v));
    return cond.in.includes(value);
  }
  if ('equals' in cond) return value === cond.equals;
  return false;
}

export function isVisible(field: ChecklistField, answers: Answers): boolean {
  if (!field.visible_if) return true;
  const dep = field.visible_if.field;
  // A condition with no field reference cannot be evaluated. Fail visible
  // rather than silently hiding a question an inspector is meant to answer.
  if (!dep) return true;
  return matches(field.visible_if, answers[dep]);
}

/** Fields currently shown, in template order. Hidden fields are not answered. */
export function visibleFields(
  template: ChecklistTemplate,
  answers: Answers,
): ChecklistField[] {
  return template.fields.filter((f) => isVisible(f, answers));
}

/**
 * The field every photograph belongs to.
 *
 * There is one place evidence lives now: the template's photo field. Photographs
 * used to be attachable to whichever question demanded one, which scattered the
 * same three pictures of the same blockage across three answers and left a
 * reviewer assembling them by hand. An inspector photographs the drain; the
 * checklist says what they found. Those are different jobs.
 */
export function photoFieldId(template: ChecklistTemplate): string | null {
  return template.fields.find((f) => f.type === 'photo')?.id ?? null;
}

/**
 * Does this field's current answer make a photo mandatory?
 *
 * This is the mechanism that stops "blockage present: yes" being submitted with
 * no evidence — the single most common way inspection data becomes unusable.
 * The requirement is unchanged; only where the photograph has to be has moved.
 */
export function requiresPhoto(field: ChecklistField, answers: Answers): boolean {
  if (!field.requires_photo_when) return false;
  if (!isVisible(field, answers)) return false;
  return matches(field.requires_photo_when, answers[field.id]);
}

/**
 * Validate the whole form.
 *
 * `photoCounts` maps field id to how many photos are attached to it. Returned
 * errors are ordered by template position so "Fix 3 problems" walks the inspector
 * down the form rather than jumping around.
 */
export function validate(
  template: ChecklistTemplate,
  answers: Answers,
  photoCounts: Record<string, number> = {},
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Answers that demand evidence are satisfied from the general photographs,
  // wherever along the drain they were taken. A surcharged drain is a condition
  // of the whole stretch, not of the question that asked about it.
  const generalId = photoFieldId(template);
  const generalField = template.fields.find((f) => f.id === generalId);
  const generalCount = generalId ? (photoCounts[generalId] ?? 0) : 0;

  for (const field of template.fields) {
    if (!isVisible(field, answers)) continue;

    const value = answers[field.id];

    if (field.type === 'photo') {
      const photos = photoCounts[field.id] ?? 0;
      const need = field.min ?? (field.required ? 1 : 0);
      if (photos < need) {
        errors.push({
          field_id: field.id,
          label: field.label,
          code: need > 1 ? 'too_few_photos' : 'photo_required',
          message:
            need > 1
              ? `${field.label}: ${need} photographs required, ${photos} attached`
              : `${field.label}: a photograph is required`,
        });
      }
      continue;
    }

    if (field.required && isBlank(value)) {
      errors.push({
        field_id: field.id,
        label: field.label,
        code: 'required',
        message: `${field.label} is required`,
      });
      continue;
    }

    if (
      (field.type === 'number' || field.type === 'severity') &&
      typeof value === 'number'
    ) {
      if (
        (field.min != null && value < field.min) ||
        (field.max != null && value > field.max)
      ) {
        errors.push({
          field_id: field.id,
          label: field.label,
          code: 'out_of_range',
          message: `${field.label} must be between ${field.min} and ${field.max}${
            field.unit ? ` ${field.unit}` : ''
          }`,
        });
      }
    }

    if (requiresPhoto(field, answers) && generalCount < 1) {
      errors.push({
        field_id: field.id,
        label: field.label,
        code: 'photo_required',
        // Named, because the field that demands the photograph is no longer the
        // field it goes on, and "requires a photograph" beside a dropdown with
        // no camera button on it is a dead end.
        message: `${field.label}: this answer needs a photograph under ${
          generalField?.label ?? 'the photographs section'
        }`,
      });
    }
  }

  return errors;
}

/**
 * Strip answers to hidden fields before submission.
 *
 * An inspector can answer "blockage type: silt", then change "blockage present"
 * back to no. Without this the orphaned answer is submitted and FRCDE receives a
 * record that contradicts itself.
 */
export function prune(template: ChecklistTemplate, answers: Answers): Answers {
  const out: Answers = {};
  for (const f of visibleFields(template, answers)) {
    if (!isBlank(answers[f.id])) out[f.id] = answers[f.id];
  }
  return out;
}

/**
 * Fraction of *required* visible fields answered — drives the progress bar.
 *
 * Required-only on purpose. Counting optional fields would pin an inspector who
 * has done everything mandatory at 80% because they left "additional remarks"
 * blank, which reads as an error when it is not one.
 */
export function completeness(template: ChecklistTemplate, answers: Answers): number {
  const fields = visibleFields(template, answers).filter(
    (f) => f.required && f.type !== 'photo' && f.type !== 'signature',
  );
  if (fields.length === 0) return 1;
  const done = fields.filter((f) => !isBlank(answers[f.id])).length;
  return done / fields.length;
}

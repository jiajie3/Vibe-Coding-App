/**
 * Checklist templates.
 *
 * Bundled for the mockup. In production these are fetched from
 * `GET /v1/checklist-templates/{id}?version=N` and cached to SQLite at sync time —
 * prefetched for every accepted job, because an inspector who reaches a site and
 * finds the checklist will not load has wasted the trip (contract §6).
 */

import type { ChecklistTemplate } from '../core/types.ts';
import openDrain from '../../assets/checklist-template.json';

const TEMPLATES: ChecklistTemplate[] = [openDrain as unknown as ChecklistTemplate];

/**
 * Resolve the template a job asks for.
 *
 * Falls back to the open-drain template so the mockup's canal jobs (which
 * reference `tpl_canal`) still render. In production a missing template must be
 * a hard error — silently substituting a different checklist would produce
 * inspection records that answer questions nobody asked.
 */
export function getTemplate(id: string, version?: number): ChecklistTemplate {
  return (
    TEMPLATES.find((t) => t.id === id && (version == null || t.version === version)) ??
    TEMPLATES[0]
  );
}

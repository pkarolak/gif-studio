import path from 'node:path';
import {z} from 'zod';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {loadProject, readJson, slugify, writeJson, type Project} from './project.js';

const targetSchema = z.union([
  z.string(),
  z.object({
    selector: z.string().optional(),
    text: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    testId: z.string().optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().optional(),
  }).strict(),
]);

const beat = {beat: z.string().optional(), caption: z.string().optional(), hold: z.number().optional()};

export const stepSchema = z.union([
  z.object({goto: z.string(), ...beat}).strict(),
  z.object({click: targetSchema, ...beat}).strict(),
  z.object({hover: targetSchema, ...beat}).strict(),
  z.object({type: z.object({target: targetSchema.optional(), label: z.string().optional(), placeholder: z.string().optional(), selector: z.string().optional(), text: z.string(), human: z.boolean().optional(), submit: z.boolean().optional()}), ...beat}).strict(),
  z.object({press: z.string(), ...beat}).strict(),
  z.object({scroll: z.object({to: targetSchema.optional(), y: z.number().optional()}), ...beat}).strict(),
  z.object({waitFor: z.union([z.object({ms: z.number()}).strict(), targetSchema]), ...beat}).strict(),
  z.object({capture: z.union([z.string(), z.boolean()]), ...beat}).strict(),
]);

export const journeySchema = z.object({
  id: z.string(),
  title: z.string(),
  why: z.string().optional(),
  score: z.number().optional(),
  viewport: z.object({width: z.number().int(), height: z.number().int()}).optional(),
  auth: z.string().optional(),
  steps: z.array(stepSchema).min(1),
});

export const journeysFileSchema = z.object({journeys: z.array(journeySchema)});

export type JourneyStep = z.infer<typeof stepSchema>;
export type Journey = z.infer<typeof journeySchema>;

export function journeysPath(project: Project): string {
  return path.join(project.assetsDir, 'journeys.json');
}

export async function loadJourneys(project: Project): Promise<Journey[]> {
  const raw = await readJson<unknown>(journeysPath(project), {journeys: []});
  const parsed = journeysFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StudioError(`journeys.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'Fix the file or re-save it with gif-studio journeys save.');
  }
  return parsed.data.journeys;
}

export async function getJourney(project: Project, id: string): Promise<Journey> {
  const journeys = await loadJourneys(project);
  const journey = journeys.find((j) => j.id === id);
  if (!journey) throw new StudioError(`Journey "${id}" not found.`, `Known journeys: ${journeys.map((j) => j.id).join(', ') || 'none'}. Save one with gif-studio journeys save.`);
  return journey;
}

export async function saveJourneys(input: unknown, options: {replace?: boolean} = {}): Promise<Outcome<{saved: string[]; total: number; file: string}>> {
  const project = await loadProject();
  const incoming = z.union([journeysFileSchema, z.array(journeySchema), journeySchema]).parse(input);
  const list = Array.isArray(incoming) ? incoming : 'journeys' in incoming ? incoming.journeys : [incoming];
  const normalized = list.map((j) => ({...j, id: slugify(j.id)}));
  const existing = options.replace ? [] : await loadJourneys(project);
  const merged = [...existing.filter((j) => !normalized.some((n) => n.id === j.id)), ...normalized];
  merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const file = journeysPath(project);
  await writeJson(file, {journeys: merged});
  return outcome(
    {saved: normalized.map((j) => j.id), total: merged.length, file: path.relative(project.root, file)},
    `Saved ${normalized.length} journey(s); ${merged.length} total in ${path.relative(project.root, file)}`,
    normalized.map((j) => `gif-studio record ${j.id}`),
  );
}

export async function listJourneys(): Promise<Outcome<Journey[]>> {
  const project = await loadProject();
  const journeys = await loadJourneys(project);
  return outcome(
    journeys,
    journeys.length ? journeys.map((j) => `${j.id}: ${j.title} (${j.steps.length} steps)${j.why ? ` — ${j.why}` : ''}`).join('\n') : 'No journeys saved yet.',
    journeys.length ? [`gif-studio record ${journeys[0]!.id}`] : ['gif-studio explore', 'gif-studio journeys save <file.json>'],
  );
}

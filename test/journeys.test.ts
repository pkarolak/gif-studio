import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {journeySchema, listJourneys, saveJourneys} from '../src/core/journeys.js';
import {tempProject} from './helpers.js';

let project: {dir: string; cleanup(): void};
beforeEach(() => {
  project = tempProject();
});
afterEach(() => project.cleanup());

const journey = {
  id: 'Create Project',
  title: 'Create a project',
  score: 5,
  steps: [
    {goto: '/', beat: 'Home'},
    {click: {role: 'button', name: 'New project'}},
    {type: {label: 'Project name', text: 'Q3 plan'}, caption: 'Name it', hold: 900},
    {waitFor: {ms: 300}},
    {scroll: {y: 400}},
    {press: 'Enter'},
    {hover: 'text=Projects'},
    {capture: 'result'},
  ],
};

describe('journeys', () => {
  it('accepts every step type', () => {
    expect(journeySchema.safeParse(journey).success).toBe(true);
  });

  it('rejects unknown steps and empty journeys', () => {
    expect(journeySchema.safeParse({...journey, steps: [{teleport: '/'}]}).success).toBe(false);
    expect(journeySchema.safeParse({...journey, steps: []}).success).toBe(false);
    expect(journeySchema.safeParse({...journey, steps: [{click: {rol: 'button'}}]}).success).toBe(false);
  });

  it('keeps waitFor durations', () => {
    const parsed = journeySchema.parse({...journey, steps: [{waitFor: {ms: 300}}]});
    expect(parsed.steps[0]).toEqual({waitFor: {ms: 300}});
  });

  it('saves, slugifies ids, merges by id and sorts by score', async () => {
    const first = await saveJourneys(journey);
    expect(first.data.saved).toEqual(['create-project']);
    await saveJourneys({journeys: [{...journey, id: 'invite', title: 'Invite', score: 9}]});
    await saveJourneys([{...journey, title: 'Create a project, v2'}]);
    const list = await listJourneys();
    expect(list.data.map((j) => j.id)).toEqual(['invite', 'create-project']);
    expect(list.data[1]!.title).toBe('Create a project, v2');
  });

  it('replaces when asked', async () => {
    await saveJourneys(journey);
    await saveJourneys({...journey, id: 'other'}, {replace: true});
    expect((await listJourneys()).data.map((j) => j.id)).toEqual(['other']);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaxonomyError, judgeExcluded, loadLabelCategories, loadTaxonomy } from '../cli/lib/eval-taxonomy.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evtax-'));
const labels = new Set(['s1', 's2', 's3', 's4']);
const category = (over = {}) => ({ id: 'loops', name: 'Loops', definition: 'repeats itself', examples: ['s1', 's2', 's3'], check: 'code', ...over });
const write = (obj) => { const f = join(tmp(), 'taxonomy.json'); writeFileSync(f, JSON.stringify(obj)); return f; };
const load = (obj) => loadTaxonomy(write(obj), { labels });

test('a valid taxonomy loads, judgeExclude defaults to an empty list', () => {
  const t = load({ categories: [category(), category({ id: 'stalls', check: 'judge', examples: ['s2', 's3', 's4'] })] });
  assert.equal(t.categories.length, 2);
  assert.deepEqual(t.judgeExclude, []);
});

test('a category with 2 examples is rejected', () => {
  assert.throws(() => load({ categories: [category({ examples: ['s1', 's2'] })] }), (e) => e instanceof TaxonomyError && /examples/.test(e.message));
});

test('an example that is not a labeled session is rejected, the value is not echoed', () => {
  assert.throws(() => load({ categories: [category({ examples: ['s1', 's2', 'secret-unlabeled'] })] }), (e) => e instanceof TaxonomyError && /examples/.test(e.message) && !e.message.includes('secret-unlabeled'));
});

test('unknown check kind is rejected', () => {
  assert.throws(() => load({ categories: [category({ check: 'human' })] }), (e) => e instanceof TaxonomyError && /check/.test(e.message));
});

test('a bad id and a duplicate id are rejected', () => {
  assert.throws(() => load({ categories: [category({ id: 'Bad_Id' })] }), (e) => e instanceof TaxonomyError && /id/.test(e.message));
  assert.throws(() => load({ categories: [category(), category()] }), (e) => e instanceof TaxonomyError && /id/.test(e.message));
});

test('a missing name or definition, a non-array categories and a non-array judgeExclude are rejected', () => {
  assert.throws(() => load({ categories: [category({ name: '' })] }), (e) => e instanceof TaxonomyError && /name/.test(e.message));
  assert.throws(() => load({ categories: [category({ definition: undefined })] }), (e) => e instanceof TaxonomyError && /definition/.test(e.message));
  assert.throws(() => load({ categories: 'x' }), (e) => e instanceof TaxonomyError && /categories/.test(e.message));
  assert.throws(() => load({ judgeExclude: 'x', categories: [category()] }), (e) => e instanceof TaxonomyError && /judgeExclude/.test(e.message));
});

test('an unreadable or unparsable file is a TaxonomyError', () => {
  assert.throws(() => loadTaxonomy(join(tmp(), 'missing.json'), { labels }), TaxonomyError);
  const f = join(tmp(), 't.json');
  writeFileSync(f, '{nope');
  assert.throws(() => loadTaxonomy(f, { labels }), TaxonomyError);
});

test('judgeExclude is returned as listed', () => {
  assert.deepEqual(load({ judgeExclude: ['~/Client/'], categories: [category()] }).judgeExclude, ['~/Client/']);
});

test('loadLabelCategories maps sessionId to ids, skipping malformed lines', () => {
  const f = join(tmp(), 'label-categories.jsonl');
  writeFileSync(f, `${JSON.stringify({ sessionId: 's1', categories: ['loops'] })}\n${JSON.stringify({ sessionId: 's2', categories: [] })}\nnot json\n${JSON.stringify({ sessionId: 's3', categories: 'x' })}\n`);
  const m = loadLabelCategories(f);
  assert.deepEqual([...m], [['s1', ['loops']], ['s2', []]]);
  assert.equal(loadLabelCategories(join(tmp(), 'none.jsonl')).size, 0);
});

const opts = { home: '/home/x', platform: 'darwin' };

test('judgeExclude defaults to an empty list, and nothing is excluded then, a null project included', () => {
  const t = load({ categories: [category()] });
  assert.deepEqual(t.judgeExclude, []);
  assert.equal(judgeExcluded('/home/x/Client', t.judgeExclude, opts), false);
  assert.equal(judgeExcluded(null, t.judgeExclude, opts), false);
  assert.equal(judgeExcluded('', undefined, opts), false);
});

test('judgeExcluded with ~/Client/ matches /home/x/Client, /home/x/Client/app, /home/x/client/app on darwin, not /home/x/ClientX', () => {
  const p = ['~/Client/'];
  assert.equal(judgeExcluded('/home/x/Client', p, opts), true);
  assert.equal(judgeExcluded('/home/x/Client/app', p, opts), true);
  assert.equal(judgeExcluded('/home/x/client/app', p, opts), true);
  assert.equal(judgeExcluded('/home/x/ClientX', p, opts), false);
  assert.equal(judgeExcluded('/home/x/ClientX/app', p, opts), false);
  assert.equal(judgeExcluded('/home/x/other', p, opts), false);
});

test('case is significant off darwin', () => {
  assert.equal(judgeExcluded('/home/x/client/app', ['~/Client/'], { home: '/home/x', platform: 'linux' }), false);
  assert.equal(judgeExcluded('/home/x/Client/app', ['~/Client/'], { home: '/home/x', platform: 'linux' }), true);
});

test('with a pattern set, a null or empty project is excluded', () => {
  assert.equal(judgeExcluded(null, ['~/Client/'], opts), true);
  assert.equal(judgeExcluded('', ['~/Client/'], opts), true);
  assert.equal(judgeExcluded(undefined, ['/abs/'], opts), true);
});

test('an absolute pattern and any matching pattern of several', () => {
  assert.equal(judgeExcluded('/srv/a/b', ['/nope/', '/srv/a'], opts), true);
  assert.equal(judgeExcluded('/srv/ab', ['/srv/a'], opts), false);
});

test('a ~ pattern without a usable home fails closed: the session is excluded', () => {
  assert.equal(judgeExcluded('/home/x/Client/app', ['~/Client/'], { platform: 'darwin' }), true);
  assert.equal(judgeExcluded('/home/x/other', ['~/Client/'], { platform: 'darwin' }), true);
  assert.equal(judgeExcluded('/home/x/other', ['~/Client/'], { home: '', platform: 'darwin' }), true);
  assert.equal(judgeExcluded('/home/x/other', ['~'], { home: undefined }), true);
  assert.equal(judgeExcluded('/home/x/other', ['/abs/', '~/Client/'], {}), true);
  assert.equal(judgeExcluded('/home/x/other', ['/abs/'], {}), false);
});

test('repeated example ids count once toward the 3-example minimum', () => {
  assert.throws(() => load({ categories: [category({ examples: ['s1', 's1', 's2'] })] }), (e) => e instanceof TaxonomyError && /examples/.test(e.message));
});

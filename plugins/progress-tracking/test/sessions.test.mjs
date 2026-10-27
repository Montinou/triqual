import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openSessions, record, readSessions, labelOf, taskOf } from '../lib/sessions.mjs';
import { agentTree, agentCount, activity } from '../ui/view.js';
const fixtures = readFileSync(new URL('./fixtures/hook-payloads.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const now = 1800000000000;
function setup(t) { const dir = mkdtempSync(join(tmpdir(), 'sessions-')); const db = openSessions(dir); t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive:true, force:true }); }); return {dir, db}; }
function replay(db) { fixtures.forEach((p,i) => record(db,p,now+i,'/work/repo')); return readSessions(db,{since:0,now}); }
test('controller, orchestrator and workers form the expected parent links', t => { const {db}=setup(t); const rows=replay(db); assert.equal(rows.length,4); const parents=Object.fromEntries(rows.map(r=>[r.agentId,r.parentAgentId])); assert.deepEqual(parents,{'':null,orchestrator:'','worker-1':'orchestrator','worker-2':'orchestrator'}); });
test('task and model come from the Agent call', t => { const {db}=setup(t); const rows=replay(db); const w=rows.find(r=>r.agentId==='worker-1'); assert.equal(w.task,'T9'); assert.equal(w.model,'fixture-input-model'); assert.equal(rows.find(r=>r.agentId==='worker-2').model,'fixture-resolved-model'); assert.equal(taskOf({description:'T3 task-4-brief',prompt:'task-5-brief'}),'T4'); assert.equal(taskOf({prompt:'T5'}),'T5'); assert.equal(taskOf({}),null); });
test('a Bash label carries the description and never the command',()=>assert.equal(labelOf({tool_name:'Bash',tool_input:{description:'Run validation',command:'secret'}}),'Bash: Run validation'));
test('a Bash payload without description labels just Bash and stores no command text',t=>{const {db}=setup(t); replay(db); assert.equal(labelOf(fixtures[11]),'Bash'); assert.ok(!JSON.stringify(readSessions(db,{since:0,now})).includes('run-it'));});
test('an Agent result without agentId creates no child row',t=>{const {db}=setup(t);record(db,fixtures[14],now,'/work/repo');assert.deepEqual(readSessions(db,{since:0,now}).map(r=>r.agentId),['orchestrator']);});
test('a child seen before its parent link has parent_agent_id null',t=>{const {db}=setup(t);record(db,fixtures[6],now,'/work/repo');assert.equal(readSessions(db,{since:0,now})[0].parentAgentId,null);});
test('labels are cut at 120 characters',()=>{assert.equal(labelOf({tool_name:'Bash',tool_input:{description:'x'.repeat(150)}}).length,120);assert.equal(labelOf({tool_name:'Read',tool_input:{file_path:'/private/a.txt'}}),'Read: a.txt');assert.equal(labelOf({tool_name:'Other'}),'Other');});
test('SessionStart deletes sessions and events older than 7 days',t=>{const {db}=setup(t);record(db,{...fixtures[1],session_id:'old'},now-8*86400000,'/work/repo');record(db,fixtures[0],now,'/work/repo');assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);assert.equal(readSessions(db,{since:0,now}).length,1);});
test('the Bash fixture whose command starts with API_KEY=zqdummyzq never stores that value anywhere in the db file',t=>{const {db,dir}=setup(t);replay(db);db.close();for(const suffix of ['', '-wal','-shm']) {const file=join(dir,`sessions.db${suffix}`);if(existsSync(file))assert.ok(!readFileSync(file).includes(Buffer.from('zqdummyzq')));}});
test('every event upserts its own (session_id, agent_id) row with repo_root and last_at, so a controller that never fired SessionStart still appears',t=>{const {db}=setup(t);record(db,fixtures[1],now,'/work/repo');const [r]=readSessions(db,{since:now,now});assert.equal(r.agentId,'');assert.equal(r.repoRoot,'/work/repo');assert.equal(r.lastAt,now);});
test('40 concurrent writer processes lose no event',async t=>{const {db,dir}=setup(t);const module=new URL('../lib/sessions.mjs',import.meta.url).href;await Promise.all(Array.from({length:40},(_,i)=>new Promise((resolve,reject)=>{const code=`import {openSessions,record} from ${JSON.stringify(module)};const db=openSessions(${JSON.stringify(dir)});record(db,${JSON.stringify(fixtures[1])},${now+i},'/work/repo');db.close();`;const p=spawn(process.execPath,['--input-type=module','-e',code]);let stderr='';p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(stderr)));})));assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,40);const [r]=readSessions(db,{since:0,now});assert.equal(r.events.length,30);assert.ok(r.events.every((e,i,a)=>!i||a[i-1].at>=e.at));});
test('the db file mode is 0600',t=>{const {dir,db}=setup(t);assert.equal(statSync(join(dir,'sessions.db')).mode&0o777,0o600);assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout,5000);assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');});

test('SessionStart reopens a completed controller in the tree, running count and repo activity', t => {
  const { db } = setup(t);
  const payload = { session_id: 'resumed' };
  for (const [hook, offset] of [['SessionStart', 0], ['SessionEnd', 1000], ['SessionStart', 2000], ['PostToolUse', 3000]]) {
    record(db, { ...payload, hook_event_name: hook, tool_name: 'Read' }, now + offset, '/work/repo');
  }
  const rows = readSessions(db, { since: 0, now: now + 3000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endedAt, null);
  assert.equal(rows[0].lastAt, now + 3000);
  assert.equal(rows[0].startedAt, now);
  assert.equal(agentTree(rows, now + 3000)[0].state, 'running');
  assert.equal(agentCount(rows, now + 3000), 1);
  const repo = { sessions: rows, plans: [] };
  assert.deepEqual(activity([repo], now + 3000).running, [repo]);
});

test('late tool and parent-link events preserve terminal controller and child state', t => {
  const { db } = setup(t);
  const payload = { session_id: 'finished' };
  record(db, { ...payload, hook_event_name: 'SessionEnd' }, now, '/work/repo');
  record(db, { ...payload, hook_event_name: 'SubagentStop', agent_id: 'child' }, now, '/work/repo');
  record(db, { ...payload, hook_event_name: 'PostToolUse', agent_id: 'child', tool_name: 'Read' }, now + 1000, '/work/repo');
  record(db, { ...payload, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_response: { agentId: 'child' } }, now + 2000, '/work/repo');
  const rows = readSessions(db, { since: 0, now: now + 2000 });
  assert.ok(rows.every(row => row.endedAt === now));
  assert.equal(rows.find(row => row.agentId === 'child').parentAgentId, '');
  assert.ok(agentTree(rows, now + 2000).every(row => row.state === 'done'));
  assert.equal(agentCount(rows, now + 2000), 0);
});

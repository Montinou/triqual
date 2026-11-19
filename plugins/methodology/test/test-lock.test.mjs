import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
const runner = fileURLToPath(new URL('../skills/executing-plans/scripts/test-lock', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Poll for something a child or the runner writes: a bounded deadline, never a fixed wait or an immediate read.
async function until(fn, what='fixture barrier') { const end=Date.now()+10000; for (;;) { if(fn()) return; if(Date.now()>=end) throw Error(`${what} timeout`); await sleep(25); } }
const lockRunning = lock => () => { try { const o=JSON.parse(readFileSync(lock,'utf8')); return o.state==='running' && !!o.child; } catch { return false; } };
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'test-lock-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync('git',['init','-q',dir]); return dir;
}
function run(cwd, code, timeout='30000', extraEnv={}) {
 const child=spawn(process.execPath,[runner,'--',process.execPath,'-e',code],{cwd,env:{...process.env,TRIQUAL_TEST_LOCK_TIMEOUT_MS:timeout,...extraEnv},stdio:['ignore','pipe','pipe']});
 let stderr=''; child.stderr.on('data',b=>stderr+=b); child.result=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,stderr}))); return child;
}
const hold = (marker, release) => `require('fs').writeFileSync(${JSON.stringify(marker)},'ready'); const t=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})){clearInterval(t)}},10)`;
test('[autonomy] sibling worktrees serialize, live owners survive age, argv and failures propagate', async t=>{
 const dir=fixture(t), sibling=join(dir,'sibling'); execFileSync('git',['-C',dir,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','init']); execFileSync('git',['-C',dir,'worktree','add','-qb','sibling',sibling]);
 const marker=join(dir,'ready'), release=join(dir,'release'), second=join(dir,'second');
 const a=run(dir,hold(marker,release)); await until(()=>existsSync(marker));
 const b=run(sibling,`require('fs').writeFileSync(${JSON.stringify(second)},'yes')`,'150');
 assert.equal((await b.result).code,75); assert.equal(existsSync(second),false);
 writeFileSync(release,''); assert.equal((await a.result).code,0);
 assert.equal((await run(sibling,'process.exit(7)').result).code,7);
 assert.equal((await run(dir,'').result).code,0);
});
test('[autonomy] killed owner cannot release a surviving child; dead owner recovers',async t=>{
 const dir=fixture(t), marker=join(dir,'ready'), release=join(dir,'release');
 const lock=join(dir,'.git','triqual-test.lock');
 const a=run(dir,hold(marker,release)); await until(()=>existsSync(marker)); await until(lockRunning(lock),'owner record'); a.kill('SIGKILL');
 assert.equal((await run(dir,'','150').result).code,75);
 writeFileSync(release,''); await sleep(100);
 assert.equal((await run(dir,'').result).code,0); await a.result;
});
test('[autonomy] unrelated repositories run independently and interrupt waits for child exit',async t=>{
 const dir=fixture(t), other=fixture(t), marker=join(dir,'ready'), release=join(dir,'release');
 const code=`process.on('SIGTERM',()=>{}); ${hold(marker,release)}`;
 const a=run(dir,code); await until(()=>existsSync(marker));
 assert.equal((await run(other,'').result).code,0); a.kill('SIGTERM');
 assert.equal((await run(dir,'','150').result).code,75); writeFileSync(release,''); await a.result;
 assert.equal((await run(dir,'').result).code,0);
});

test('[autonomy] foreign ownership fails closed, reused PID recovers, replacement nonce survives release',async t=>{
 const dir=fixture(t), lock=join(dir,'.git','triqual-test.lock');
 const host=(await import('node:os')).hostname();
 const stale={nonce:'fixture',host,parent:{pid:process.pid,start:'different process incarnation'},state:'running',child:null};
 writeFileSync(lock,JSON.stringify({...stale,host:'foreign-host.invalid'}));
 assert.equal((await run(dir,'','100').result).code,75);
 assert.equal(JSON.parse(readFileSync(lock)).host,'foreign-host.invalid');
 writeFileSync(lock,JSON.stringify(stale)); assert.equal((await run(dir,'').result).code,0);
 const marker=join(dir,'ready'),release=join(dir,'release');
 const a=run(dir,hold(marker,release)); await until(()=>existsSync(marker)); await until(lockRunning(lock),'owner record');
 const replacement={...stale,nonce:'replacement',host:'foreign-host.invalid'};
 writeFileSync(lock,JSON.stringify(replacement)); writeFileSync(release,''); await a.result;
 assert.equal(JSON.parse(readFileSync(lock)).nonce,'replacement');
});
test('[autonomy] stale contenders serialize actual children; argv remains literal',async t=>{
 const dir=fixture(t), lock=join(dir,'.git','triqual-test.lock'), active=join(dir,'active');
 writeFileSync(lock,JSON.stringify({nonce:'fixture',host:(await import('node:os')).hostname(),parent:{pid:process.pid,start:'old incarnation'},state:'running',child:null}));
 const code=`const fs=require('fs');fs.writeFileSync(${JSON.stringify(active)},'held',{flag:'wx'});setTimeout(()=>fs.unlinkSync(${JSON.stringify(active)}),40)`;
 const children=Array.from({length:4},()=>run(dir,code));
 for(const child of children) assert.equal((await child.result).code,0);
 const literal='$(touch unexpected); spaces';
 const child=spawn(process.execPath,[runner,'--',process.execPath,'-e',`if(process.argv[1]!==${JSON.stringify(literal)})process.exit(9)`,literal],{cwd:dir,stdio:'ignore'});
 assert.equal(await new Promise(r=>child.on('close',r)),0); assert.equal(existsSync(join(dir,'unexpected')),false);
 const missing=spawn(process.execPath,[runner,'--',join(dir,'missing-executable')],{cwd:dir,stdio:'ignore'});
 assert.equal(await new Promise(r=>missing.on('close',r)),1);
 assert.equal((await run(dir,'').result).code,0);
});

test('[autonomy] nested same-repository commands inherit verified ownership without deadlock', async t=>{
 const dir=fixture(t);
 const code=`const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(runner)},'--',process.execPath,'-e',''],{stdio:'inherit'});process.exit(r.status??1)`;
 assert.equal((await run(dir,code,'150').result).code,0);
});

test('[autonomy] copied and stale inherited markers cannot bypass another process owner',async t=>{
 const dir=fixture(t), marker=join(dir,'ready'),release=join(dir,'release'),lock=join(dir,'.git','triqual-test.lock');
 const a=run(dir,hold(marker,release)); await until(()=>existsSync(marker)); await until(lockRunning(lock),'owner record');
 const owner=JSON.parse(readFileSync(lock));
 for(const nonce of [owner.nonce,'stale-fixture']) {
  assert.equal((await run(dir,'','150',{TRIQUAL_TEST_LOCK_OWNER:`${lock}:${nonce}`} ).result).code,75);
 }
 writeFileSync(release,''); assert.equal((await a.result).code,0);
});

test('[autonomy] synchronous landing timeout bounds a TERM-ignoring owned child', async t => {
 const dir=fixture(t), pidFile=join(dir,'child-pid');
 const begin=Date.now();
 // The sync timeout must outlast process start-up under load; the child's natural exit (10 s) stays well past the bound.
 const result=spawnSync(process.execPath,[runner,'--',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>{},10000)`],{cwd:dir,env:{...process.env,TRIQUAL_TEST_LOCK_TIMEOUT_MS:'8000'},timeout:2000,encoding:'utf8'});
 assert.equal(result.error?.code,'ETIMEDOUT');
 assert.ok(Date.now()-begin<6000,'timeout waited for natural child exit');
 assert.notEqual(result.status,0);
 await until(()=>existsSync(pidFile),'child pid file');
 const pid=Number(readFileSync(pidFile,'utf8'));
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.equal(existsSync(join(dir,'.git','triqual-test.lock')),false);
});
test('[autonomy] interruption wins over a cooperative child exit zero',async t=>{
 const dir=fixture(t),ready=join(dir,'ready');
 const child=run(dir,`process.on('SIGTERM',()=>process.exit(0));require('fs').writeFileSync(${JSON.stringify(ready)},'');setTimeout(()=>{},6000)`);
 await until(()=>existsSync(ready)); child.kill('SIGTERM');
 assert.equal((await child.result).code,143);
 assert.equal(existsSync(join(dir,'.git','triqual-test.lock')),false);
});

test('[autonomy] interruption during ownership release cannot become success',async t=>{
 const dir=fixture(t),ready=join(dir,'ready'),release=join(dir,'release');
 const lock=join(dir,'.git','triqual-test.lock'),guard=lock+'.guard';
 const child=run(dir,hold(ready,release));
 await until(()=>existsSync(ready) && JSON.parse(readFileSync(lock)).state==='running');
 const pid=JSON.parse(readFileSync(lock)).child.pid;
 mkdirSync(guard); writeFileSync(release,'');
 await until(()=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}});
 await sleep(50); child.kill('SIGTERM'); await sleep(50); rmdirSync(guard);
 assert.equal((await child.result).code,143);
 assert.equal(existsSync(lock),false);
});

test('a wait past TRIQUAL_TEST_LOCK_TIMEOUT_MS exits 75, prints the busy line and never runs the command', async t => {
 const dir=fixture(t), sibling=join(dir,'sibling'); execFileSync('git',['-C',dir,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','init']); execFileSync('git',['-C',dir,'worktree','add','-qb','sibling',sibling]);
 const marker=join(dir,'ready'), release=join(dir,'release'), second=join(dir,'second');
 const a=run(dir,hold(marker,release)); await until(()=>existsSync(marker));
 const b=await run(sibling,`require('fs').writeFileSync(${JSON.stringify(second)},'yes')`,'150').result;
 assert.equal(b.code,75); assert.match(b.stderr,/^test lock busy: .*triqual-test\.lock$/m); assert.equal(existsSync(second),false);
 writeFileSync(release,''); assert.equal((await a.result).code,0);
});
test('a child that exits 75 exits 1, so 75 always means the lock', async t => {
 const dir=fixture(t);
 assert.equal((await run(dir,'process.exit(75)').result).code,1);
});
test('no command and no -- print the usage and exit 1', () => {
 for (const args of [[runner],[runner,'x'],[runner,'--']]) {
  const r=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(r.status,1); assert.match(r.stderr,/usage: node test-lock -- COMMAND ARG\.\.\./);
 }
});
test('outside a git repository it fails closed: exit 1 and the command does not run', async t => {
 const dir=mkdtempSync(join(tmpdir(),'test-lock-nogit-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const marker=join(dir,'ran');
 const r=await run(dir,`require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`,'3000',{GIT_CEILING_DIRECTORIES:dirname(dir)}).result;
 assert.equal(r.code,1); assert.match(r.stderr,/not a git repository/); assert.equal(existsSync(marker),false);
});
test('an invalid TRIQUAL_TEST_LOCK_TIMEOUT_MS exits 1 and the command does not run', async t => {
 const dir=fixture(t), marker=join(dir,'ran');
 const r=await run(dir,`require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`,'soon').result;
 assert.equal(r.code,1); assert.match(r.stderr,/invalid TRIQUAL_TEST_LOCK_TIMEOUT_MS/); assert.equal(existsSync(marker),false);
});
test('a child killed with SIGKILL exits 137', async t => {
 const dir=fixture(t);
 assert.equal((await run(dir,"process.kill(process.pid, 'SIGKILL')").result).code,137);
});
test('a held .guard directory during acquisition exits 75 with the busy line and the command does not run', async t => {
 const dir=fixture(t), marker=join(dir,'ran'), guard=join(dir,'.git','triqual-test.lock.guard');
 mkdirSync(guard);
 const r=await run(dir,`require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`,'150').result;
 assert.equal(r.code,75); assert.match(r.stderr,/^test lock busy: .*triqual-test\.lock$/m); assert.equal(existsSync(marker),false);
 assert.equal(existsSync(guard),true);
});

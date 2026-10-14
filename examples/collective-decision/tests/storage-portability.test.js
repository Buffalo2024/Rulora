const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
const {spawnSync}=require('node:child_process')
const {resolveDataRoot,dataPath,resolveRuntimePath}=require('../src/runtime-paths')
const {JobStorage}=require('../src/job-storage')
const {WebJobManager}=require('../src/web-job-manager')
const {ModelCallCheckpointStore}=require('../src/model-call-checkpoint-store')
const {verifyEvidenceSnapshots}=require('../src/evidence-registry')
const {sha256}=require('../src/utils')
function restore(value){if(value===undefined)delete process.env.RULORA_DATA_ROOT;else process.env.RULORA_DATA_ROOT=value}
test('runtime defaults and relative settings remain independent of cwd',()=>{
 assert.equal(resolveDataRoot('/app',''),'/app/.runtime');assert.equal(resolveDataRoot('/app','../state'),'/state')
 const old=process.env.RULORA_DATA_ROOT;try{process.env.RULORA_DATA_ROOT='/state';assert.equal(dataPath('/app','logs'),'/state/logs');assert.equal(resolveRuntimePath('/app','.runtime/checkpoints'),'/state/checkpoints');assert.equal(resolveRuntimePath('/app','config/a'),'/app/config/a');assert.equal(resolveRuntimePath('/app','/mounted/custom'),'/mounted/custom')}finally{restore(old)}
})
test('portable traversal is rejected; external paths are not guessed; Windows legacy paths rebase',()=>{
 const s=new JobStorage({codeRoot:'/new/app',dataRoot:'/new/state'})
 for(const ref of ['@rulora/data/../secret','@rulora/data//etc/passwd','@rulora/invalid/log'])assert.throws(()=>s.decode({job_id:'job',output_directory:ref}),/portable storage path|storage path escapes/i)
 const migrated=s.decode({job_id:'job',output_directory:'/old/state/web-ui/outputs/job',log_path:'/old/state/web-ui/logs/job.log',case_path:'/external/case.json'})
 assert.equal(migrated.log_path,'/new/state/web-ui/logs/job.log');assert.equal(migrated.case_path,'/external/case.json')
 assert.equal(s.decode({job_id:'job',output_directory:'C:\\old\\.runtime\\web-ui\\outputs\\job',case_path:'C:\\old\\.runtime\\web-ui\\outputs\\job\\case.json'}).case_path,'/new/state/web-ui/outputs/job/case.json')
})
test('copy whole data root: new and legacy tasks recover evidence, logs, artifacts and validated checkpoints',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'rulora-move-'));t.after(async()=>{for(const dir of [path.join(tmp,'code'),path.join(tmp,'code/config'),path.join(tmp,'code/examples')])await fs.chmod(dir,0o755).catch(()=>{});await fs.rm(tmp,{recursive:true,force:true})})
 const old=process.env.RULORA_DATA_ROOT;t.after(()=>restore(old))
 const code=path.join(tmp,'code'),from=path.join(tmp,'from'),to=path.join(tmp,'to')
 await fs.mkdir(path.join(code,'config'),{recursive:true});await fs.mkdir(path.join(code,'examples'))
 for(const f of ['agents.json','enterprise-sources.json'])await fs.copyFile(path.join(__dirname,'../config',f),path.join(code,'config',f))
 await fs.writeFile(path.join(code,'examples/companies.json'),JSON.stringify({records:[{company_id:'001',company_name:'虚构迁移样本有限公司',industry:'制造业'}]}))
 // Confirm the manager can operate with a genuinely read-only code/config tree.
 for(const dir of [path.join(code,'config'),path.join(code,'examples')]) {for(const name of await fs.readdir(dir))await fs.chmod(path.join(dir,name),0o444);await fs.chmod(dir,0o555)}
 await fs.chmod(code,0o555)
 process.env.RULORA_DATA_ROOT=from
 const m=new WebJobManager({root:code});m.pump=()=>{};await m.initialize();const rows=[]
 const identity={contract_version:'1.0.0',operation:'seat_initial',evidence_version:'frozen-v1'};let calls=0
 for(const legacy of [false,true]){
  const created=await m.createJob({company_id:'001',deferPump:true,user_consent:true,consent_action:'start_analysis'}),job=m.jobs.get(created.job_id)
  await fs.mkdir(job.output_directory,{recursive:true});const snapshots=path.join(job.output_directory,'evidence-snapshots');await fs.mkdir(snapshots)
  const bytes=Buffer.from('synthetic immutable evidence'),hash=sha256(bytes);await fs.writeFile(path.join(snapshots,hash+'.bin'),bytes)
  job.case_path=path.join(job.output_directory,'enterprise-case.json');job.status='paused'
  const caseBytes=JSON.stringify({evidence_snapshot_root:snapshots,evidence:[{id:'e1',snapshot_ref:hash+'.bin',content_sha256:hash}]});await fs.writeFile(job.case_path,caseBytes)
  const report=path.join(job.output_directory,'report.json');await fs.writeFile(report,'{}');job.result={artifacts:{report_json:report}}
  await new ModelCallCheckpointStore({rootDirectory:job.model_call_checkpoint_root}).execute({identity,run:async()=>{calls++;return{output:{accepted:true},events:[]}},validate:v=>assert.equal(v.accepted,true)})
  await m.persistJob(job);const file=path.join(m.jobsDirectory,job.job_id+'.json'),saved=JSON.parse(await fs.readFile(file));assert.ok(saved.output_directory.startsWith('@rulora/data/'))
  if(legacy){const raw=structuredClone(job);delete raw.storage_origins;await fs.writeFile(file,JSON.stringify(raw))}rows.push({id:job.job_id,caseBytes})
 }
 assert.equal(calls,2);await fs.cp(from,to,{recursive:true});await fs.rm(from,{recursive:true,force:true});process.env.RULORA_DATA_ROOT=to
 const moved=new WebJobManager({root:code});moved.pump=()=>{};await moved.initialize()
 for(const row of rows){
  const job=moved.jobs.get(row.id);assert.ok(job.output_directory.startsWith(to));assert.match((await moved.getLogs(job.job_id)).text,/queued/)
  const c=await moved.readJobDocument(job,job.case_path);assert.ok(c.evidence_snapshot_root.startsWith(to));assert.deepEqual(await verifyEvidenceSnapshots(c.evidence,{snapshotRoot:c.evidence_snapshot_root,productionMode:true}),[]);assert.equal(await fs.readFile(job.case_path,'utf8'),row.caseBytes)
  assert.equal(await moved.getArtifact(job.job_id,'report'),path.join(job.output_directory,'report.json'))
  const checkpoint=await new ModelCallCheckpointStore({rootDirectory:job.model_call_checkpoint_root}).execute({identity,run:async()=>{throw Error('Must reuse valid checkpoint')},validate:v=>assert.equal(v.accepted,true)});assert.equal(checkpoint.checkpoint.status,'reused')
  await moved.resumeJob(job.job_id);assert.equal(job.status,'queued')
 }
 await assert.rejects(fs.access(path.join(code,'.runtime')),{code:'ENOENT'})
 const again=new WebJobManager({root:code});again.pump=()=>{};await again.initialize();const job=again.jobs.get(rows[0].id);assert.ok((await again.readJobDocument(job,job.case_path)).evidence_snapshot_root.startsWith(to))
})
test('trace, collector and health defaults share data root from a foreign cwd',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'rulora-cwd-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true}));const root=path.join(tmp,'data'),cwd=path.join(tmp,'foreign');await fs.mkdir(cwd)
 const script=`const {persistLlmOutputTrace}=require(${JSON.stringify(path.join(__dirname,'../src/llm-output-trace'))});const {PublicSourceCollector}=require(${JSON.stringify(path.join(__dirname,'../src/source-collector'))});const {ProviderHealthMonitor}=require(${JSON.stringify(path.join(__dirname,'../src/provider-health-monitor'))});persistLlmOutputTrace({call_id:'synthetic'}).then(file=>console.log(JSON.stringify({file,snapshot:new PublicSourceCollector().snapshotDirectory,health:new ProviderHealthMonitor().directory})))`
 const r=spawnSync(process.execPath,['-e',script],{cwd,env:{...process.env,RULORA_DATA_ROOT:root,LLM_OUTPUT_TRACE_ROOT:''},encoding:'utf8'});assert.equal(r.status,0,r.stderr);for(const p of Object.values(JSON.parse(r.stdout)))assert.ok(p.startsWith(root),p);await assert.rejects(fs.access(path.join(cwd,'.runtime')),{code:'ENOENT'})
})

const test=require('node:test'),assert=require('node:assert/strict')
const {callProfiles,callWithModelRouting}=require('../src/enterprise-model-routing')
const patch=require('../config/countercheck-nanshu.patch.json')
const {resolveModelConfiguration,modelConfigurationFingerprint}=require('../src/model-readiness')
function provider(active=true){return {config:{contract_version:'1.0.0',profiles:{red_team_reasoner:{model:'old'},factor_reasoner:{model:'factor'},...patch.profiles},enterprise_model_routing:patch.enterprise_model_routing},environment:active?{NANSHU_COUNTERCHECK_API_KEY:'test-only'}:{}}}
test('new key absent preserves old routes and excludes dormant readiness profiles',()=>{
 const p=provider(false);assert.deepEqual(callProfiles(p,{agent_id:'direction_countercheck',model_profile:'red_team_reasoner'}),['red_team_reasoner','decision_reasoner']);assert.deepEqual(Object.keys(resolveModelConfiguration(p.config,p.environment).profiles),['red_team_reasoner','factor_reasoner','decision_reasoner']);assert.notEqual(modelConfigurationFingerprint(p.config,p.environment),modelConfigurationFingerprint(p.config,provider().environment));
})
test('both countercheck seats use exact ordered three-model route; reviewer uses it as backup',()=>{
 const p=provider();for(const id of ['direction_countercheck','condition_countercheck'])assert.deepEqual(callProfiles(p,{agent_id:id,model_profile:'red_team_reasoner'}),patch.enterprise_model_routing.countercheck_profiles)
 assert.deepEqual(callProfiles(p,{agent_id:'enterprise_semantic_reviewer',model_profile:'red_team_reasoner'}),['red_team_reasoner',...patch.enterprise_model_routing.countercheck_profiles])
 assert.deepEqual(callProfiles(p,{agent_id:'public_evidence_monitor',model_profile:'monitor_extractor'}),['monitor_extractor'])
})
test('transport failures fall through sol/astra/GLM with unchanged prompt, identity and references',async()=>{
 const p=provider(),calls=[],events=[],prompt=[{role:'user',content:'json'}],binding={version:'frozen'}
 p.callForJson=async r=>{calls.push(r);if(calls.length<3)throw Object.assign(new Error('timeout'),{code:'MODEL_API_TIMEOUT'});return {ok:true}}
 assert.deepEqual(await callWithModelRouting(p,{agent:{agent_id:'condition_countercheck',model_profile:'red_team_reasoner'},prompt,referenceBinding:binding},'condition_initial',async e=>events.push(e)),{ok:true});assert.deepEqual(calls.map(c=>c.agent.model_profile),patch.enterprise_model_routing.countercheck_profiles);assert(calls.every(c=>c.prompt===prompt&&c.referenceBinding===binding&&c.agent.agent_id==='condition_countercheck'));assert.equal(events.length,2)
})
test('contract/auth failures do not switch models; exhaustion stops after three',async()=>{
 for(const code of ['MODEL_SCHEMA_FAILURE','MODEL_API_AUTHENTICATION_FAILED','MODEL_API_TIMEOUT']){
 const p=provider();let n=0;p.callForJson=async()=>{n++;throw Object.assign(new Error('fail'),{code})};await assert.rejects(callWithModelRouting(p,{agent:{agent_id:'direction_countercheck',model_profile:'red_team_reasoner'}},'x'),e=>e.code===code);assert.equal(n,code==='MODEL_API_TIMEOUT'?3:1)
 }
})
test('new key accepted by strict environment parser',()=>{assert.equal(require('../src/local-model-environment').parseRoleEnvironment('NANSHU_COUNTERCHECK_API_KEY=test-only').NANSHU_COUNTERCHECK_API_KEY,'test-only')})
test('GLM is the terminal fallback for chain, factor and semantic review with no duplicate profile',()=>{
 const p=provider();p.config.profiles.chain_reasoner={model:'astra'}
 for(const [agent_id,model_profile] of [['demand_growth','chain_reasoner'],['technology_fit','factor_reasoner'],['enterprise_semantic_reviewer','red_team_reasoner']]){
  const route=callProfiles(p,{agent_id,model_profile});assert.equal(route.at(-1),'decision_reasoner');assert.equal(new Set(route).size,route.length)
 }
 assert.equal(p.config.profiles.decision_reasoner.model,'glm-5.3-flash')
 assert.deepEqual(callProfiles(p,{agent_id:'decision',model_profile:'decision_reasoner'}),['decision_reasoner','countercheck_primary','countercheck_secondary'])
})
test('last route has one bounded longer timeout retry and failures preserve the complete safe route chain',async()=>{
 const p=provider(),calls=[]
 p.callForJson=async r=>{calls.push(r);throw Object.assign(new Error('timeout'),{code:'MODEL_API_TIMEOUT',model:'unchanged',transport_diagnostics:[{attempt:1,phase:'waiting_headers',timeout_ms:150000,authorization:'secret'}]})}
 await assert.rejects(callWithModelRouting(p,{agent:{agent_id:'condition_countercheck',model_profile:'red_team_reasoner'}},'condition_initial'),e=>{
  assert.equal(e.routing_attempts.length,3);assert(!JSON.stringify(e.routing_attempts).includes('secret'));return true
 })
 assert.deepEqual(calls.map(x=>x.transportPolicy),[{maxTimeoutRetries:0,timeoutRetryMs:null},{maxTimeoutRetries:0,timeoutRetryMs:null},{maxTimeoutRetries:1,timeoutRetryMs:600000}])
})
test('network connection failures can use the existing configured backup',async()=>{
 const p=provider();let calls=0
 p.callForJson=async()=>{if(++calls===1)throw Object.assign(new Error('fetch failed'),{code:'MODEL_API_NETWORK_FAILURE'});return {ok:true}}
 assert.deepEqual(await callWithModelRouting(p,{agent:{agent_id:'condition_countercheck',model_profile:'red_team_reasoner'}},'condition_initial'),{ok:true});assert.equal(calls,2)
})

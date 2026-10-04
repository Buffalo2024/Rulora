const RETRYABLE = new Set(['MODEL_API_CAPACITY_OR_RATE_LIMIT','MODEL_API_TIMEOUT','MODEL_API_UPSTREAM_FAILURE','MODEL_API_EMPTY_RESPONSE','MODEL_API_NETWORK_FAILURE'])
function profileActive(profile, environment=process.env) { return !profile.activation_key_env || Boolean(environment[profile.activation_key_env]?.trim()) }
function callProfiles(provider, agent) {
 const routing=provider.config?.enterprise_model_routing,env=provider.environment || process.env
 if(routing && env[routing.activation_key_env]?.trim()) {
  const chain=routing.countercheck_profiles
  if(!Array.isArray(chain)||!chain.length||new Set(chain).size!==chain.length||chain.some(id=>!provider.config.profiles[id]||!profileActive(provider.config.profiles[id],env))) throw Object.assign(new Error('反向核查备用路由配置无效'),{code:'MODEL_ROUTING_INVALID'})
  if(['direction_countercheck','condition_countercheck'].includes(agent.agent_id)) return [...chain]
  if(routing.backup_for_profiles?.includes(agent.model_profile)) return [...new Set([agent.model_profile,...chain])]
 }
 return ['chain_reasoner','factor_reasoner','red_team_reasoner'].includes(agent.model_profile)?[agent.model_profile,'decision_reasoner']:[agent.model_profile]
}
async function callWithModelRouting(provider, request, phase, emit=async()=>{}) {
 const profiles=callProfiles(provider,request.agent)
 const routingAttempts=[]
 for(let i=0;i<profiles.length;i++) {
  const agent={...request.agent,model_profile:profiles[i]}
   // A full response deadline has already elapsed. Switch to the existing
   // backup without spending two more full deadlines on the same profile.
   try {return await provider.callForJson({...request,agent,transportPolicy:{maxTimeoutRetries:i<profiles.length-1?0:1,timeoutRetryMs:i===profiles.length-1?600000:null}})} catch(error) {
   routingAttempts.push({model_profile:profiles[i],model:error.model || null,code:error.code || 'RUN_FAILED',transport_diagnostics: (error.transport_diagnostics || []).map(({attempt,timeout_ms,elapsed_ms,phase,headers_ms,http_status,request_id,network_cause_code})=>({attempt,timeout_ms,elapsed_ms,phase,headers_ms,http_status,request_id,network_cause_code}))})
   error.routing_attempts=structuredClone(routingAttempts)
   if(!RETRYABLE.has(error.code)||error.retryable===false||i===profiles.length-1)throw error
   await emit({type:'model_fallback',phase,agent_id:agent.agent_id,from_profile:profiles[i],to_profile:profiles[i+1],reason:error.code})
  }
 }
}
module.exports={profileActive,callProfiles,callWithModelRouting}

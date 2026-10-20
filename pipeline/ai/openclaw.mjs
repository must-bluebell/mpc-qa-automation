import { INSTRUCTIONS } from './providers.mjs'

/** Use the authenticated local gateway; OAuth credentials remain managed by OpenClaw. */
export async function requestOpenClaw({baseUrl,agent,key,input,schema,fetchImpl=fetch}) {
  let url
  try {url=new URL(baseUrl)}catch {throw new Error('OpenClaw requires a loopback gateway URL.')}
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')
    throw new Error('OpenClaw requires a loopback gateway URL without credentials, query or path.')
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(agent??''))throw new Error('OpenClaw requires a valid dedicated review agent ID.')
  let response,data
  try {
    response=await fetchImpl(new URL('/v1/responses',url).href,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(300_000),
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:`openclaw/${agent}`,stream:false,store:false,tools:[],tool_choice:'none',max_output_tokens:6000,
        instructions:`${INSTRUCTIONS} Return exactly one JSON object, without Markdown or commentary, conforming to this JSON schema: ${JSON.stringify(schema)}. Findings and duplicate groups must reference only existing finding IDs, not passing test IDs. If there are no recorded findings, both arrays must be empty.`,
        input:JSON.stringify(input)}),
    })
    if(response.ok)data=await response.json()
  }catch {throw new Error('OpenClaw review could not complete (gateway unavailable, invalid response or timeout); test results are unchanged.')}
  if(!response.ok)throw new Error(`OpenClaw AI service answered HTTP ${response.status}; test results are unchanged.`)
  if(data?.status!=='completed'||!Array.isArray(data.output)||data.output.some(item=>item.type==='function_call'))
    throw new Error('AI analysis was incomplete or attempted a tool call; test results are unchanged.')
  const text=data.output.filter(item=>item.type==='message'&&item.role==='assistant').flatMap(item=>item.content??[])
    .filter(item=>item.type==='output_text').map(item=>item.text).join('')
  if(!text)throw new Error('AI analysis returned no usable text; test results are unchanged.')
  try{return JSON.parse(text)}catch {throw new Error('AI analysis was not valid JSON; test results are unchanged.')}
}

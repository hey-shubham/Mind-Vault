import dotenv from 'dotenv';
dotenv.config();
import { spawn } from 'node:child_process';

const groqKey=process.env.GROQ_API_KEY?.trim();
const openRouterKey=process.env.OPENROUTER_API_KEY?.trim();
const openaiKey=process.env.OPENAI_API_KEY?.trim();
const geminiKey=process.env.GEMINI_API_KEY?.trim();
const cerebrasKey=process.env.CEREBRAS_API_KEY?.trim();
const sambanovaKey=process.env.SAMBANOVA_API_KEY?.trim();
const hfKey=process.env.HF_TOKEN?.trim();
const cohereKey=process.env.COHERE_API_KEY?.trim();
const deepseekKey=process.env.DEEPSEEK_API_KEY?.trim();
const mistralKey=process.env.MISTRAL_API_KEY?.trim();
const togetherKey=process.env.TOGETHER_API_KEY?.trim();

const groqBase=(process.env.GROQ_BASE_URL||'https://api.groq.com/openai/v1').replace(/\/$/,'');
const openRouterBase=(process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1').replace(/\/$/,'');
const cerebrasBase=(process.env.CEREBRAS_BASE_URL||'https://api.cerebras.ai/v1').replace(/\/$/,'');
const sambaBase=(process.env.SAMBANOVA_BASE_URL||'https://api.sambanova.ai/v1').replace(/\/$/,'');
const hfBase=(process.env.HF_BASE_URL||'https://router.huggingface.co/v1').replace(/\/$/,'');
const deepseekBase=(process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com').replace(/\/$/,'');
const mistralBase=(process.env.MISTRAL_BASE_URL||'https://api.mistral.ai/v1').replace(/\/$/,'');
const togetherBase=(process.env.TOGETHER_BASE_URL||'https://api.together.ai/v1').replace(/\/$/,'');
const ollamaBase=(process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434').replace(/\/$/,'');

const groqFastModel=process.env.GROQ_FAST_MODEL?.trim()||'llama-3.1-8b-instant';
const groqSmartModel=process.env.GROQ_SMART_MODEL?.trim()||'openai/gpt-oss-120b';
const openRouterModel=process.env.OPENROUTER_MODEL?.trim()||'openrouter/free';
const openaiModel=process.env.OPENAI_CHAT_MODEL?.trim()||'gpt-4o-mini';
const geminiModel=process.env.GEMINI_MODEL?.trim()||'gemini-3.6-flash';
const cerebrasModel=process.env.CEREBRAS_MODEL?.trim()||'llama-3.3-70b';
const sambaModel=process.env.SAMBANOVA_MODEL?.trim()||'Meta-Llama-3.3-70B-Instruct';
const hfModel=process.env.HF_MODEL?.trim()||'openai/gpt-oss-120b:fastest';
const cohereModel=process.env.COHERE_MODEL?.trim()||'command-r7b-12-2024';
const deepseekModel=process.env.DEEPSEEK_MODEL?.trim()||'deepseek-v4-flash';
const mistralModel=process.env.MISTRAL_MODEL?.trim()||'mistral-small-latest';
const togetherModel=process.env.TOGETHER_MODEL?.trim()||'openai/gpt-oss-20b';

const ollamaModel=process.env.OLLAMA_MODEL?.trim()||'qwen3:8b';
const ollamaEmbedModel=process.env.OLLAMA_EMBED_MODEL?.trim()||'nomic-embed-text';

const providerMode=(process.env.AI_PROVIDER||'smart').trim().toLowerCase();
const localOnly=String(process.env.AI_LOCAL_ONLY||'false').toLowerCase()==='true';
const cloudAvailable=Boolean(groqKey||openRouterKey||openaiKey||geminiKey||cerebrasKey||sambanovaKey||hfKey||cohereKey||deepseekKey||mistralKey||togetherKey);
const autoStartOllama=String(process.env.OLLAMA_AUTO_START||'true').toLowerCase()==='true';

const cache=new Map<string,{ts:number,value:string}>();
const providerCooldown=new Map<string,number>();
const CACHE_MS=5*60*1000;
const COOLDOWN_MS=15_000;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

let ollamaBootAttempted=false;

function keyOf(system:string,user:string){return `${system}\n---\n${user}`.slice(0,30000);}
function isFreshEnough(provider:string){return (providerCooldown.get(provider)||0)>Date.now();}
function failProvider(provider:string){providerCooldown.set(provider,Date.now()+COOLDOWN_MS);}

function wantsAdvanced(user:string){
  const q=user.toLowerCase();
  return q.length>500 || /(debug|code|program|javascript|typescript|react|node|algorithm|prove|derive|complex|compare|architecture|system design|yaml|mermaid|diagram|step by step|deep|detailed|pdf|document|image|analyze|analysis|research)/i.test(q);
}

async function postJson(url:string,body:any,headers:Record<string,string>,timeoutMs:number){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},signal:controller.signal,body:JSON.stringify(body)});
    const d:any=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d?.error?.message||d?.error||`AI request failed (${r.status})`);
    return d;
  }finally{clearTimeout(timer);}
}

async function groqGenerate(system:string,user:string,temperature=.2){
  if(!groqKey) throw new Error('Groq is not configured');
  const advanced=wantsAdvanced(user);
  const model=advanced?groqSmartModel:groqFastModel;
  const d=await postJson(
    `${groqBase}/chat/completions`,
    {
      model,
      messages:[{role:'system',content:system},{role:'user',content:user}],
      temperature,
      max_tokens:advanced?5000:1400,
      top_p:.9,
      stream:false
    },
    {Authorization:`Bearer ${groqKey}`},
    advanced?25_000:15_000
  );
  const text=String(d?.choices?.[0]?.message?.content||'').trim();
  if(!text) throw new Error('Groq returned an empty response');
  return text;
}

async function openRouterGenerate(system:string,user:string,temperature=.2){
  if(!openRouterKey) throw new Error('OpenRouter is not configured');
  const d=await postJson(
    `${openRouterBase}/chat/completions`,
    {
      model:openRouterModel,
      messages:[{role:'system',content:system},{role:'user',content:user}],
      temperature,
      max_tokens:5000,
      stream:false
    },
    {Authorization:`Bearer ${openRouterKey}`,'HTTP-Referer':process.env.CLIENT_ORIGIN||'http://localhost:5173','X-Title':'Mind Vault'},
    25_000
  );
  const text=String(d?.choices?.[0]?.message?.content||'').trim();
  if(!text) throw new Error('OpenRouter returned an empty response');
  return text;
}

async function openaiGenerate(system:string,user:string,temperature=.2){
  if(!openaiKey) throw new Error('OpenAI is not configured');
  const d=await postJson(
    'https://api.openai.com/v1/chat/completions',
    {model:openaiModel,messages:[{role:'system',content:system},{role:'user',content:user}],temperature,max_tokens:1100},
    {Authorization:`Bearer ${openaiKey}`},
    25_000
  );
  const text=String(d?.choices?.[0]?.message?.content||'').trim();
  if(!text) throw new Error('OpenAI returned an empty response');
  return text;
}

async function geminiGenerate(system:string,user:string,temperature=.2){
  if(!geminiKey) throw new Error('Gemini is not configured');
  const d=await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
    {systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:user}]}],generationConfig:{maxOutputTokens:5000,temperature}},
    {},
    25_000
  );
  const text=d?.candidates?.[0]?.content?.parts?.map((p:any)=>String(p.text||'')).join('').trim()||'';
  if(!text) throw new Error('Gemini returned an empty response');
  return text;
}


async function compatibleGenerate(base:string,key:string,model:string,system:string,user:string,temperature=.2,timeoutMs=20_000){
  if(!key) throw new Error('Provider not configured');
  const d=await postJson(`${base}/chat/completions`,{model,messages:[{role:'system',content:system},{role:'user',content:user}],temperature,max_tokens:wantsAdvanced(user)?5000:1400,stream:false},{Authorization:`Bearer ${key}`,'Accept':'application/json'},timeoutMs);
  const text=String(d?.choices?.[0]?.message?.content||'').trim();
  if(!text)throw new Error('Provider returned an empty response');
  return text;
}
async function cohereGenerate(system:string,user:string,temperature=.2){
  if(!cohereKey)throw new Error('Cohere not configured');
  const d=await postJson('https://api.cohere.com/v2/chat',{model:cohereModel,messages:[{role:'system',content:system},{role:'user',content:user}],temperature,max_tokens:wantsAdvanced(user)?5000:1400},{Authorization:`Bearer ${cohereKey}`,'Accept':'application/json'},20_000);
  const text=String(d?.message?.content?.map((x:any)=>x?.text||'').join('')||'').trim();
  if(!text)throw new Error('Cohere returned an empty response');
  return text;
}

async function ollamaReachable(timeoutMs=1200){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const r=await fetch(`${ollamaBase}/api/tags`,{signal:controller.signal});return r.ok;}
  catch{return false}
  finally{clearTimeout(timer);}
}

async function maybeStartOllama(){
  if(!autoStartOllama||ollamaBootAttempted||await ollamaReachable()) return;
  ollamaBootAttempted=true;
  try{
    const child=spawn('ollama',['serve'],{detached:true,stdio:'ignore',windowsHide:true});
    child.unref();
  }catch{}
  for(let i=0;i<8;i++){if(await ollamaReachable(900))return;await sleep(400);}
}

async function ollamaGenerate(system:string,user:string,temperature=.2){
  await maybeStartOllama();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),25_000);
  try{
    const r=await fetch(`${ollamaBase}/api/chat`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal:controller.signal,
      body:JSON.stringify({
        model:ollamaModel,
        stream:false,
        think:false,
        messages:[{role:'system',content:system},{role:'user',content:user}],
        options:{temperature,top_p:.9,num_predict:wantsAdvanced(user)?5000:1200,num_ctx:8192},
        keep_alive:'30m'
      })
    });
    const d:any=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d?.error||`Ollama request failed (${r.status})`);
    const text=String(d?.message?.content||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
    if(!text)throw new Error('Ollama returned an empty response');
    return text;
  }finally{clearTimeout(timer);}
}

async function ollamaEmbed(text:string){
  await maybeStartOllama();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10_000);
  try{
    const r=await fetch(`${ollamaBase}/api/embed`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal:controller.signal,
      body:JSON.stringify({model:ollamaEmbedModel,input:[text.slice(0,12000)]})
    });
    const d:any=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d?.error||`Ollama embedding failed (${r.status})`);
    return d?.embeddings?.[0]||null;
  }finally{clearTimeout(timer);}
}

export async function embed(text:string){
  try{
    const v=await ollamaEmbed(text);
    if(v)return v;
  }catch{}
  return null;
}

function basicLocalFallback(system:string,user:string){
  const q=user.replace(/Recent conversation messages:[\s\S]*/i,'').trim();
  if(/\b(hi|hello|hey|hye|hii|namaste)\b/i.test(q))return '## Hello 👋\n\nI’m ready. Ask me anything — maths, coding, study, planning, writing, or a Mind Vault question.';
  const name=q.match(/\b(?:my name is|i am|i'm|call me)\s+([A-Za-z][A-Za-z .'-]{1,48})/i);
  if(name)return `## Got it\n\nI’ll remember your name as **${name[1].trim()}**.`;
  if(/\bwhat(?:'s| is) my name\b/i.test(q)){
    const mem=user.match(/name:\s*(.+)/i);
    return mem?`## Your name\n\nYour saved name is **${mem[1].trim()}**.`:'## Your name\n\nI don’t have a saved name yet.';
  }
  const math=q.match(/^\s*(?:calculate|solve|what is|compute)\s*([0-9\s()+\-*/%.]+)\??\s*$/i);
  if(math){
    try{
      const expr=math[1].replace(/%/g,'/100');
      const result=Function(`"use strict";return (${expr})`)();
      return `## Answer\n\n**${math[1].trim()} = ${result}**`;
    }catch{}
  }
  if(/how does mind vault work|what is mind vault|mind vault features/i.test(q)){
    return '## Mind Vault\n\n**My Vault** stores your files. **Search** finds and explains indexed knowledge. **AI Assistant** handles general questions. **Study Room** creates source-grounded quizzes. **Focus Board** manages tasks.';
  }
  return '## I’m ready\n\nYour message was saved, but the AI providers are temporarily unavailable. Mind Vault can retry automatically when a provider is back.';
}

export async function generate(system:string,user:string,temperature=.2){
  const ck=keyOf(system,user);
  const hit=cache.get(ck);
  if(hit&&Date.now()-hit.ts<CACHE_MS)return hit.value;

  const providers:[string,()=>Promise<string>][]=[];
  const add=(name:string,fn:()=>Promise<string>)=>{if(!isFreshEnough(name))providers.push([name,fn]);};

  const allowCloud = !localOnly && (providerMode!=='local' || cloudAvailable);
  if(allowCloud){
    if(groqKey)add('Groq',()=>groqGenerate(system,user,temperature));
    if(cerebrasKey)add('Cerebras',()=>compatibleGenerate(cerebrasBase,cerebrasKey,cerebrasModel,system,user,temperature,18_000));
    if(sambanovaKey)add('SambaNova',()=>compatibleGenerate(sambaBase,sambanovaKey,sambaModel,system,user,temperature,20_000));
    if(mistralKey)add('Mistral',()=>compatibleGenerate(mistralBase,mistralKey,mistralModel,system,user,temperature,20_000));
    if(deepseekKey)add('DeepSeek',()=>compatibleGenerate(deepseekBase,deepseekKey,deepseekModel,system,user,temperature,20_000));
    if(togetherKey)add('Together',()=>compatibleGenerate(togetherBase,togetherKey,togetherModel,system,user,temperature,20_000));
    if(hfKey)add('HuggingFace',()=>compatibleGenerate(hfBase,hfKey,hfModel,system,user,temperature,20_000));
    if(openRouterKey)add('OpenRouter',()=>openRouterGenerate(system,user,temperature));
    if(geminiKey)add('Gemini',()=>geminiGenerate(system,user,temperature));
    if(cohereKey)add('Cohere',()=>cohereGenerate(system,user,temperature));
    if(openaiKey)add('OpenAI',()=>openaiGenerate(system,user,temperature));
  }
  // Local model is a last-resort fallback, never the only route unless explicitly selected.
  if(providerMode==='local'||providerMode==='smart'||!providers.length||localOnly)add('Ollama',()=>ollamaGenerate(system,user,temperature));

  let last:any=null;
  for(const [name,fn] of providers){
    try{
      const value=await fn();
      if(value){
        cache.set(ck,{ts:Date.now(),value});
        return value;
      }
    }catch(e:any){
      last=e;
      failProvider(name);
    }
  }

  // Never expose provider errors to the UI.
  return basicLocalFallback(system,user);
}

export const hasAI=Boolean(groqKey||openRouterKey||openaiKey||geminiKey||cerebrasKey||sambanovaKey||hfKey||cohereKey||deepseekKey||mistralKey||togetherKey||ollamaModel);
export const aiModel=groqKey?`groq:${groqFastModel}`:(cerebrasKey?`cerebras:${cerebrasModel}`:(sambanovaKey?`sambanova:${sambaModel}`:(mistralKey?`mistral:${mistralModel}`:(deepseekKey?`deepseek:${deepseekModel}`:(togetherKey?`together:${togetherModel}`:(hfKey?`hf:${hfModel}`:(openRouterKey?`openrouter:${openRouterModel}`:(geminiKey?geminiModel:(cohereKey?cohereModel:(openaiKey?openaiModel:`ollama:${ollamaModel}`))))))))));

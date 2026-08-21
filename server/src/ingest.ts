import fs from 'node:fs/promises';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import {JSDOM} from 'jsdom';
import {createWorker} from 'tesseract.js';
import {embed} from './ai.js';
import {db} from './db.js';

function splitText(text:string,size=1000,overlap=180){
 const raw=text.replace(/\r/g,'').replace(/[ \t]+/g,' ').trim();
 const out:string[]=[];
 for(let i=0;i<raw.length;i+=size-overlap){const part=raw.slice(i,i+size).trim();if(part.length>25)out.push(part)}
 return out;
}

export async function extract(filePath:string,type:string,name:string,url?:string){
 if(url){const res=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error(`URL returned ${res.status}`);const html=await res.text();const dom=new JSDOM(html);dom.window.document.querySelectorAll('script,style,noscript,svg').forEach(x=>x.remove());return {text:(dom.window.document.body?.textContent||'').replace(/\s+/g,' ').trim(),pages:[null]};}
 const buf=await fs.readFile(filePath);
 if(type.includes('pdf')||name.toLowerCase().endsWith('.pdf')){
  const pageTexts:string[]=[];let counter=0;
  const r=await pdf(buf,{pagerender:async(pageData:any)=>{const tc=await pageData.getTextContent({normalizeWhitespace:true,disableCombineTextItems:false});const text=tc.items.map((x:any)=>x.str).join(' ').replace(/\s+/g,' ').trim();pageTexts[counter]=text;counter++;return text;}} as any);
  return {text:r.text,pages:pageTexts};
 }
 if(type.includes('word')||name.toLowerCase().endsWith('.docx')){const r=await mammoth.extractRawText({buffer:buf});return {text:r.value,pages:[null]};}
 if(type.startsWith('text/')||name.match(/\.(txt|md|csv)$/i))return {text:buf.toString('utf8'),pages:[null]};
 if(type.startsWith('image/')){const worker=await createWorker('eng');const {data}=await worker.recognize(buf);await worker.terminate();return {text:data.text,pages:[null]};}
 throw new Error('Unsupported file type');
}

export async function indexDocument(documentId:number,text:string,pages:any[]){
 db.prepare('DELETE FROM chunks WHERE document_id=?').run(documentId);
 const insert=db.prepare('INSERT INTO chunks(document_id,chunk_index,text,page,embedding,created_at) VALUES(?,?,?,?,?,?)');
 let index=0;
 const pageList=Array.isArray(pages)&&pages.length&&pages.some((p:any)=>typeof p==='string')?pages:null;
 if(pageList){
  for(let p=0;p<pageList.length;p++){
   const pageText=String(pageList[p]||'').trim();
   for(const chunk of splitText(pageText)){let vector=null;try{vector=await embed(chunk)}catch{}insert.run(documentId,index++,chunk,p+1,vector?JSON.stringify(vector):null,new Date().toISOString())}
  }
 }else{
  for(const chunk of splitText(text)){let vector=null;try{vector=await embed(chunk)}catch{}insert.run(documentId,index++,chunk,null,vector?JSON.stringify(vector):null,new Date().toISOString())}
 }
 return index;
}

export function cosine(a:number[],b:number[]){let dot=0,aa=0,bb=0;for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return dot/(Math.sqrt(aa)*Math.sqrt(bb)||1)}
function termsFor(q:string){const stop=new Set(['the','a','an','is','are','was','were','what','why','how','can','could','please','tell','about','explain','describe','define','means','mean','smjha','samjha','de','do','hai','hota','kya','ka','ke','ko','me','mein','for','from','with','and','or','to','of','on','in','my','your']);return Array.from(new Set(q.toLowerCase().split(/[^a-z0-9_+#.-]+/).filter(x=>x.length>=3&&!stop.has(x))));}
function lexicalScore(text:string,q:string,title=''){
 const t=text.toLowerCase();const titleText=title.toLowerCase();const query=q.toLowerCase().trim();if(!query)return 0;const terms=termsFor(query);let score=t.includes(query)?1.65:0;const hits=terms.reduce((n,w)=>n+(t.includes(w)?1:0),0);score+=terms.length?(hits/terms.length)*1.1:0;const titleHits=terms.reduce((n,w)=>n+(titleText.includes(w)?1:0),0);score+=terms.length?(titleHits/terms.length)*0.55:0;const long=terms.filter(x=>x.length>5);score+=long.reduce((n,w)=>n+(t.split(w).length-1)*0.07,0);return Math.min(score,3.2);
}

export async function retrieve(userId:number,q:string,workspaceId?:number,documentIds?:number[]){
 const where=["d.status='ready'",'d.user_id=?'];const params:any[]=[userId];
 if(workspaceId){where.push('d.workspace_id=?');params.push(workspaceId)}
 if(documentIds?.length){where.push(`d.id IN (${documentIds.map(()=>'?').join(',')})`);params.push(...documentIds)}
 const rows=db.prepare(`SELECT c.*,d.name,d.workspace_id,d.user_id,d.type,d.updated_at FROM chunks c JOIN documents d ON d.id=c.document_id WHERE ${where.join(' AND ')}`).all(...params) as any[];
 let qv=null;try{qv=await embed(q)}catch{}
 const ranked=rows.map(r=>{const semantic=qv&&r.embedding?cosine(qv,JSON.parse(r.embedding)):0;const lexical=lexicalScore(r.text,q,r.name);const exact=lexical>=1.65?0.18:0;return {...r,score:Math.min(1,semantic*0.48+(lexical/3.2)*0.52+exact)};});
 return ranked.filter(r=>r.score>= (qv?0.16:0.14)).sort((a,b)=>b.score-a.score).slice(0,12);
}

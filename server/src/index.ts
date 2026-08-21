import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import {db} from './db.js';
import {auth,hashPassword,comparePassword,sign,userByEmail,log,verify} from './auth.js';
import {extract,indexDocument,retrieve} from './ingest.js';
import {generate,hasAI} from './ai.js';
import {deleteStoredFile,materializeStoredFile,persistUploadedFile,sendStoredFile,storageStatus} from './storage.js';

const app=express();
const PORT=Number(process.env.PORT||4000);
const GOOGLE_CLIENT_ID=String(process.env.GOOGLE_CLIENT_ID||'').trim();
const SERVER_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uploads=path.join(SERVER_ROOT,'uploads');
const stored=path.join(SERVER_ROOT,'data/files');
fs.mkdirSync(uploads,{recursive:true});
fs.mkdirSync(stored,{recursive:true});
const allowedOrigins=String(process.env.CLIENT_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()).filter(Boolean);
app.use(cors({origin:(origin,callback)=>{if(!origin||allowedOrigins.includes(origin))return callback(null,true);return callback(new Error('CORS origin not allowed'));},credentials:false}));
app.use(express.json({limit:'4mb'}));
app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','SAMEORIGIN');
 res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 res.setHeader('Permissions-Policy','camera=(self),microphone=(self),geolocation=(self)');
 next();
});

const ALLOWED_UPLOAD_EXTENSIONS=new Set(['.pdf','.docx','.txt','.md','.csv','.png','.jpg','.jpeg','.webp','.gif','.mp3','.wav','.m4a','.js','.ts','.tsx','.jsx','.html','.css','.json','.yaml','.yml']);
const upload=multer({dest:uploads,limits:{fileSize:50*1024*1024},fileFilter:(_req,file,cb)=>{const ext=path.extname(file.originalname||'').toLowerCase();if(!ALLOWED_UPLOAD_EXTENSIONS.has(ext))return cb(new Error('Unsupported file type'));cb(null,true)}});
const now=()=>new Date().toISOString();
function safeUser(u:any){return {id:u.id,email:u.email,name:u.name,username:u.username||'',phone:u.phone||'',created_at:u.created_at,last_seen:u.last_seen||u.created_at,avatar_url:u.avatar_path?`/api/profile/avatar/${u.id}`:(u.avatar_url||'')}}
function requireWorkspace(userId:number,wid:number){return db.prepare(`SELECT w.*,COALESCE(wm.role,'owner') role FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=? WHERE w.id=? AND (w.owner_id=? OR wm.user_id=?)`).get(userId,wid,userId,userId) as any}
function sanitizeFilename(name:string){return path.basename(name).replace(/[^a-zA-Z0-9._() -]/g,'_').slice(0,180)||'file'}
function makeShareToken(){return crypto.randomBytes(32).toString('hex')}
function makeUsername(name:string){const base=String(name||'user').toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,22)||'user';let u=base;let i=1;while(db.prepare('SELECT 1 FROM users WHERE username=?').get(u))u=base+(++i);return u}
async function serveMessageAttachment(req:any,res:any,kind:'direct'|'group',download=false){
  try{
    const id=Number(req.params.id);const idx=Number(req.params.index);
    const table=kind==='group'?'group_messages':'direct_messages';
    const msg=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
    if(!msg)return res.status(404).json({error:'Message not found'});
    const member=kind==='group'
      ?db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(msg.group_id,req.user.id)
      :db.prepare('SELECT 1 FROM direct_members WHERE thread_id=? AND user_id=?').get(msg.thread_id,req.user.id);
    if(!member)return res.status(403).json({error:'Access denied'});
    let attachments:any[]=[];try{attachments=msg.attachment_json?JSON.parse(msg.attachment_json):[]}catch{}
    const attachment=attachments[idx];if(!attachment?.documentId)return res.status(404).json({error:'Attachment not found'});
    const document=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(Number(attachment.documentId),msg.sender_id) as any;
    if(!document?.storage_path)return res.status(404).json({error:'Attachment file unavailable'});
    await sendStoredFile(res,document.storage_path,document.name,document.type,download);
  }catch{if(!res.headersSent)res.status(404).json({error:'Attachment file unavailable'})}
}

const httpServer=createServer(app);
const wsClients=new Map<number,Set<any>>();
const WS_GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSend(socket:any,payload:any){
  if(!socket||socket.destroyed)return;
  const data=Buffer.from(JSON.stringify(payload));
  let header:Buffer;
  if(data.length<126){header=Buffer.from([0x81,data.length]);}
  else if(data.length<65536){header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(data.length,2);}
  else{header=Buffer.alloc(10);header[0]=0x81;header[1]=127;header.writeBigUInt64BE(BigInt(data.length),2);}
  socket.write(Buffer.concat([header,data]));
}
function wsBroadcast(userId:number,payload:any){for(const socket of wsClients.get(userId)||[])wsSend(socket,payload)}
function removeWs(userId:number,socket:any){const set=wsClients.get(userId);if(!set)return;set.delete(socket);if(!set.size)wsClients.delete(userId)}
function handleWsFrame(state:any){
  const {socket,userId}=state;
  let buf:Buffer=state.buffer;
  while(buf.length>=2){
    const b1=buf[0],b2=buf[1]; const fin=!!(b1&0x80), opcode=b1&0x0f; const masked=!!(b2&0x80); let len=b2&0x7f; let offset=2;
    if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);offset=4}
    else if(len===127){if(buf.length<10)return;const big=buf.readBigUInt64BE(2);if(big>BigInt(Number.MAX_SAFE_INTEGER))return socket.destroy();len=Number(big);offset=10}
    if(masked)offset+=4; if(buf.length<offset+len)return;
    let payload=buf.subarray(offset,offset+len); const mask=masked?buf.subarray(offset-4,offset):null;
    if(mask){const copy=Buffer.from(payload);for(let i=0;i<copy.length;i++)copy[i]^=mask[i%4];payload=copy}
    buf=buf.subarray(offset+len);
    if(opcode===0x8){socket.end();return}
    if(opcode===0x9){const hdr=Buffer.from([0x8A,payload.length]);socket.write(Buffer.concat([hdr,payload]));continue}
    if(opcode!==0x1 || !fin)continue;
    try{const msg=JSON.parse(payload.toString('utf8')); if(msg?.type==='subscribe'&&Number.isFinite(Number(msg.threadId)))state.threadId=Number(msg.threadId);}catch{}
  }
  state.buffer=buf;
}
httpServer.on('upgrade',(req:any,socket:any)=>{
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(url.pathname!=='/ws/chat'){socket.destroy();return}
    const token=String(url.searchParams.get('token')||''); const user=verify(token); if(!user?.id)throw new Error('auth');
    const key=req.headers['sec-websocket-key']; if(typeof key!=='string')throw new Error('key');
    const accept=createHash('sha1').update(key+WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    socket.setNoDelay(true); const state={socket,userId:Number(user.id),buffer:Buffer.alloc(0)};
    if(!wsClients.has(state.userId))wsClients.set(state.userId,new Set()); wsClients.get(state.userId).add(socket);
    socket.on('data',(chunk:Buffer)=>{state.buffer=Buffer.concat([state.buffer,chunk]);handleWsFrame(state)});
    socket.on('close',()=>removeWs(state.userId,socket)); socket.on('error',()=>removeWs(state.userId,socket));
    wsSend(socket,{type:'connected',userId:state.userId});
  }catch{socket.destroy()}
});

function cleanSourceText(text:string){
  return String(text||'')
    .replace(/\b(?:Definition|Advantages?|Disadvantages?|Information Retrieved|Hinglish Explanation|Diagram|Page \d+)\b\s*:?/gi,' ')
    .replace(/\s*[⭐★]{2,}\s*/g,' ')
    .replace(/[|]{2,}/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function sentencePool(text:string){
  const cleaned=cleanSourceText(text);
  return cleaned.split(/(?<=[.!?])\s+/).map(x=>x.trim()).filter(x=>x.length>35 && !/^\d+\.?$/.test(x));
}
function fallbackKnowledgeAnswer(question:string,hits:any[]){
  const rawQuestion=String(question).trim();
  const terms=rawQuestion.toLowerCase().split(/[^a-z0-9+#.-]+/).filter((x:string)=>x.length>2 && !['what','is','are','the','and','for','how','why','explain','define','about','please','from','this','that'].includes(x));
  const scored:{s:string;score:number;name:string;page:any}[]=[];
  for(const h of hits){
    for(const sent of sentencePool(h.text)){
      let score=0; const low=sent.toLowerCase();
      for(const t of terms){ if(low.includes(t)) score+=3; }
      if(/\b(is|are|means|refers to|defined as)\b/i.test(sent)) score+=1.5;
      if(sent.length<180) score+=.5;
      scored.push({s:sent,score,name:h.name,page:h.page});
    }
  }
  const chosen=Array.from(new Map(scored.sort((a,b)=>b.score-a.score).map(x=>[x.s.toLowerCase(),x])).values()).slice(0,5);
  const topic=rawQuestion.replace(/\b(?:explain|describe|define|tell me about|samjha de|samjha do|smjha de|what is|what are|how does|how do|please)\b/ig,'').replace(/[?]+$/,'').replace(/\s{2,}/g,' ').trim()||'This topic';
  if(!chosen.length)return `## ${topic}\n\nI couldn’t find enough relevant indexed material to answer this accurately.`;
  const direct=chosen[0].s;
  const points=chosen.slice(1,4).map(x=>`- ${x.s}`);
  const related=chosen.slice(4,5).map(x=>`**Related:** ${x.s}`);
  return `## ${topic}\n\n**Answer**\n${direct}\n\n**Key points**\n${points.length?points.join('\n'):'- The indexed source contains the core explanation above.'}${related.length?`\n\n${related.join('\n')}`:''}\n\n**In simple words**\nThe answer above is synthesized from the strongest matching parts of your vault rather than copying a full paragraph.`;
}

app.get('/api/health',(_,res)=>res.json({ok:true,environment:process.env.NODE_ENV||'development',ai:hasAI,model:process.env.OPENAI_CHAT_MODEL||process.env.GEMINI_MODEL||'local',storage:storageStatus}));
app.get('/api/auth/google/config',(req,res)=>res.json({enabled:Boolean(GOOGLE_CLIENT_ID),clientId:GOOGLE_CLIENT_ID||null}));
function normalizePhone(value:string){
  const raw=String(value||'').trim();
  if(!raw)return '';
  const compact=raw.replace(/[\s().-]/g,'');
  if(/^\+\d{8,15}$/.test(compact))return compact;
  if(/^\d{10}$/.test(compact))return '+91'+compact;
  return '';
}
app.post('/api/auth/google',async(req,res)=>{
  try{
    if(!GOOGLE_CLIENT_ID)return res.status(503).json({error:'Google authentication is not configured on this server'});
    const idToken=String(req.body?.credential||'').trim();
    if(!idToken)return res.status(400).json({error:'Google credential required'});
    const tokenResp=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(idToken));
    if(!tokenResp.ok) throw new Error('Invalid Google token');
    const payload:any=await tokenResp.json();
    if(String(payload.aud||'')!==GOOGLE_CLIENT_ID) throw new Error('Invalid Google audience');
    const email=String(payload.email||'').toLowerCase();
    if(!email||String(payload.email_verified||'').toLowerCase()!=='true')return res.status(401).json({error:'Google account email could not be verified'});
    const existing=userByEmail(email) as any;
    if(existing){
      db.prepare(`UPDATE users SET last_seen=?,name=COALESCE(NULLIF(?,''),name),avatar_url=CASE WHEN avatar_path IS NULL OR avatar_path='' THEN COALESCE(?,avatar_url) ELSE avatar_url END WHERE id=?`).run(now(),String(payload?.name||'').trim(),String(payload?.picture||'').trim()||null,existing.id);
      const u=db.prepare('SELECT * FROM users WHERE id=?').get(existing.id) as any;
      return res.json({token:sign(u),user:safeUser({...u,last_seen:now()}),workspaceId:null});
    }
    return res.status(409).json({error:'Create your Mind Vault account with a username and phone number first. Google sign-in can be used after the account exists.'});
  }catch(e:any){return res.status(401).json({error:'Google sign-in failed. Please try again.'})}
});
app.post('/api/auth/forgot-password',async(req:any,res:any)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    if(!email)return res.status(400).json({error:'Email is required'});
    const u=userByEmail(email) as any;
    // Local/dev-friendly reset flow: issue a short-lived one-time token. Production email delivery can wrap this endpoint.
    if(!u)return res.json({message:'If that account exists, password reset instructions are ready.'});
    const token=crypto.randomBytes(32).toString('hex');
    const expires=Date.now()+15*60*1000;
    db.prepare('INSERT OR REPLACE INTO user_memories(user_id,memory_key,memory_value,created_at,updated_at) VALUES(?,?,?,?,?)').run(u.id,'password_reset',JSON.stringify({token,expires}),now(),now());
    res.json({message:'Password reset link created.',resetUrl:`/reset-password?token=${token}&email=${encodeURIComponent(email)}`});
  }catch{res.status(500).json({error:'Could not create reset request'})}
});

app.post('/api/auth/reset-password',async(req:any,res:any)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase(); const token=String(req.body.token||''); const password=String(req.body.password||'');
    if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
    const u=userByEmail(email) as any; if(!u)return res.status(400).json({error:'Invalid reset request'});
    const row=db.prepare("SELECT memory_value FROM user_memories WHERE user_id=? AND memory_key='password_reset'").get(u.id) as any;
    let data:any=null; try{data=JSON.parse(row?.memory_value||'null')}catch{}
    if(!data||data.token!==token||Number(data.expires)<Date.now())return res.status(400).json({error:'Reset link is invalid or expired'});
    db.prepare('UPDATE users SET password_hash=?,last_seen=? WHERE id=?').run(await hashPassword(password),now(),u.id);
    db.prepare("DELETE FROM user_memories WHERE user_id=? AND memory_key='password_reset'").run(u.id);
    res.json({ok:true,message:'Password reset successfully. You can sign in now.'});
  }catch{res.status(500).json({error:'Could not reset password'})}
});

app.get('/api/auth/username-availability',(req:any,res:any)=>{const username=String(req.query.username||'').trim().toLowerCase();const valid=/^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){1,28}[a-z0-9]$/.test(username);if(!valid)return res.json({available:false,valid:false});const exists=db.prepare('SELECT id FROM users WHERE username=?').get(username);res.json({available:!exists,valid:true})});
app.post('/api/auth/register',async(req,res)=>{try{const {email,password,name,phone,username}=req.body;const cleanEmail=String(email||'').trim().toLowerCase();const cleanName=String(name||'').trim();const cleanPhone=normalizePhone(phone);const cleanUsername=String(username||'').trim().toLowerCase();if(!cleanEmail||!password||!cleanName||!cleanUsername)return res.status(400).json({error:'Name, username, email and password are required'});if(!/^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){1,28}[a-z0-9]$/.test(cleanUsername))return res.status(400).json({error:'Username must be 3-30 characters and may contain letters, numbers, hyphens and dots'});if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});if(userByEmail(cleanEmail))return res.status(409).json({error:'Email already registered'});if(db.prepare('SELECT 1 FROM users WHERE username=?').get(cleanUsername))return res.status(409).json({error:'Username not available'});const ures=db.prepare('INSERT INTO users(email,password_hash,name,username,phone,created_at,last_seen) VALUES(?,?,?,?,?,?,?)').run(cleanEmail,await hashPassword(password),cleanName,cleanUsername,cleanPhone,now(),now());const u=db.prepare('SELECT * FROM users WHERE id=?').get(ures.lastInsertRowid) as any;db.prepare('INSERT INTO user_memories(user_id,memory_key,memory_value,created_at,updated_at) VALUES(?,?,?,?,?)').run(u.id,'name',u.name,now(),now());const ws=db.prepare('INSERT INTO workspaces(name,owner_id,created_at) VALUES(?,?,?)').run('Personal workspace',u.id,now());log(u.id,'signup','user',u.id);return res.json({token:sign(u),user:safeUser(u),workspaceId:ws.lastInsertRowid})}catch(e){res.status(500).json({error:'Registration failed'})}});
app.post('/api/auth/login',async(req,res)=>{const {identifier,email,password}=req.body;const key=String(identifier||email||'').trim().toLowerCase();const u=(userByEmail(key)||db.prepare('SELECT * FROM users WHERE username=?').get(key)) as any;if(!u||!(await comparePassword(password||'',u.password_hash)))return res.status(401).json({error:'Invalid email or password'});db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(),u.id);log(u.id,'login','user',u.id);res.json({token:sign(u),user:safeUser({...u,last_seen:now()})})});
app.get('/api/auth/me',auth,(req:any,res)=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) as any; if(!u)return res.status(404).json({error:'User not found'}); db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(),u.id); res.json({user:safeUser({...u,last_seen:now()})})});
app.post('/api/presence/ping',auth,(req:any,res)=>{db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(),req.user.id);res.json({ok:true,last_seen:now()})});
app.get('/api/profile',auth,(req:any,res)=>{const u=db.prepare('SELECT id,email,name,username,phone,last_seen,avatar_path,avatar_url FROM users WHERE id=?').get(req.user.id) as any;res.json(safeUser(u))});
app.patch('/api/profile',auth,(req:any,res)=>{const phone=req.body.phone!==undefined?String(req.body.phone||'').trim():undefined;const name=req.body.name!==undefined?String(req.body.name||'').trim():undefined;const username=req.body.username!==undefined?String(req.body.username||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,''):undefined;const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) as any;if(!u)return res.status(404).json({error:'User not found'});if(username&&!/^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){1,28}[a-z0-9]$/.test(username))return res.status(400).json({error:'Username must be 3-30 characters and may contain letters, numbers, hyphens and dots'});if(username&&db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(username,u.id))return res.status(409).json({error:'Username not available'});if(req.body.phone!==undefined&&!phone)return res.status(400).json({error:'Phone number is required'});db.prepare('UPDATE users SET phone=COALESCE(?,phone),name=COALESCE(?,name),username=COALESCE(?,username),last_seen=? WHERE id=?').run(phone,name,username,now(),u.id);res.json({ok:true,message:'Profile saved',user:safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id))})});
app.post('/api/profile/avatar',auth,upload.single('file'),async(req:any,res:any)=>{const f=req.file as any;if(!f)return res.status(400).json({error:'Photo required'});try{const ext=path.extname(f.originalname||'').slice(0,8)||'.jpg';const dir=path.join(stored,String(req.user.id));await fsp.mkdir(dir,{recursive:true});const dest=path.join(dir,`avatar${ext}`);await fsp.copyFile(f.path,dest);try{await fsp.unlink(f.path)}catch{};db.prepare('UPDATE users SET avatar_path=?,avatar_url=NULL WHERE id=?').run(dest,req.user.id);res.json({ok:true,avatar_url:`/api/profile/avatar/${req.user.id}`})}catch{res.status(500).json({error:'Could not save profile photo'})}});
app.get('/api/profile/avatar/:id',async(req,res)=>{const u=db.prepare('SELECT avatar_path FROM users WHERE id=?').get(req.params.id) as any;if(!u?.avatar_path||!fs.existsSync(u.avatar_path))return res.status(404).end();res.sendFile(path.resolve(u.avatar_path))});

app.get('/api/tasks',auth,(req:any,res)=>res.json(db.prepare("SELECT * FROM tasks WHERE user_id=? ORDER BY done ASC, CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC").all(req.user.id)));
app.post('/api/tasks',auth,(req:any,res)=>{const title=String(req.body.title||'').trim();if(!title)return res.status(400).json({error:'Task title required'});const priority=['high','medium','low'].includes(req.body.priority)?req.body.priority:'medium';const dueAt=req.body.dueAt?String(req.body.dueAt):null;const r=db.prepare('INSERT INTO tasks(user_id,title,priority,due_at,done,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(req.user.id,title,priority,dueAt,0,now(),now());const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid);log(req.user.id,'task_created','task',Number(r.lastInsertRowid));res.json(task)});
app.patch('/api/tasks/:id',auth,(req:any,res)=>{const t=db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!t)return res.status(404).json({error:'Task not found'});const title=req.body.title!==undefined?String(req.body.title).trim():t.title;const priority=['high','medium','low'].includes(req.body.priority)?req.body.priority:t.priority;const done=req.body.done!==undefined?(req.body.done?1:0):t.done;db.prepare('UPDATE tasks SET title=?,priority=?,done=?,updated_at=? WHERE id=?').run(title,priority,done,now(),t.id);res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id))});
app.put('/api/tasks/:id',auth,(req:any,res)=>{const t=db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!t)return res.status(404).json({error:'Task not found'});const title=req.body.title!==undefined?String(req.body.title).trim():t.title;const priority=['high','medium','low'].includes(req.body.priority)?req.body.priority:t.priority;const done=req.body.done!==undefined?(req.body.done?1:0):t.done;db.prepare('UPDATE tasks SET title=?,priority=?,done=?,updated_at=? WHERE id=?').run(title,priority,done,now(),t.id);res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id))});
app.delete('/api/tasks/:id',auth,(req:any,res)=>{const r=db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id,req.user.id);if(!r.changes)return res.status(404).json({error:'Task not found'});res.json({ok:true})});

app.get('/api/notifications',auth,(req:any,res)=>{const rows=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);const unread=rows.filter((x:any)=>!x.seen).length;res.json({items:rows,unread})});
app.post('/api/notifications/:id/read',auth,(req:any,res)=>{db.prepare('UPDATE notifications SET seen=1 WHERE id=? AND user_id=?').run(req.params.id,req.user.id);res.json({ok:true})});
app.post('/api/notifications/read-all',auth,(req:any,res)=>{db.prepare('UPDATE notifications SET seen=1 WHERE user_id=?').run(req.user.id);res.json({ok:true})});
app.delete('/api/notifications/:id',auth,(req:any,res)=>{db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(Number(req.params.id),req.user.id);res.json({ok:true})});

app.get('/api/dashboard',auth,(req:any,res)=>{const id=req.user.id;const counts={sources:(db.prepare('SELECT COUNT(*) n FROM documents WHERE user_id=?').get(id) as any).n,indexed:(db.prepare("SELECT COUNT(*) n FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.user_id=?").get(id) as any).n,questions:(db.prepare("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND m.role='user'").get(id) as any).n,notes:(db.prepare('SELECT COUNT(*) n FROM notes WHERE user_id=?').get(id) as any).n,tasks:(db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id=? AND done=0').get(id) as any).n};const recent=db.prepare('SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 8').all(id);res.json({counts,recent,ai:hasAI})});

app.get('/api/documents',auth,(req:any,res)=>{const q=String(req.query.q||'');const rows=db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.document_id=d.id) chunk_count FROM documents d WHERE d.user_id=? AND (d.name LIKE ? OR d.content LIKE ?) ORDER BY d.created_at DESC`).all(req.user.id,`%${q}%`,`%${q}%`);res.json(rows)});
app.post('/api/documents/upload',auth,upload.array('files',10),async(req:any,res)=>{const files=req.files as any[];if(!files?.length)return res.status(400).json({error:'No files selected'});const out=[];for(const f of files){const t=now();const r=db.prepare('INSERT INTO documents(user_id,workspace_id,name,type,size,status,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(req.user.id,null,f.originalname,f.mimetype,f.size,'processing','',t,t);const id=Number(r.lastInsertRowid);let storagePath='';try{const x=await extract(f.path,f.mimetype,f.originalname);storagePath=await persistUploadedFile({sourcePath:f.path,userId:req.user.id,documentId:id,name:f.originalname,type:f.mimetype});db.prepare('UPDATE documents SET content=?,status=?,storage_path=?,updated_at=? WHERE id=?').run(x.text,'ready',storagePath,now(),id);const n=await indexDocument(id,x.text,x.pages);log(req.user.id,'document_uploaded','document',id,{chunks:n,storage:storageStatus.mode});out.push(db.prepare('SELECT * FROM documents WHERE id=?').get(id));}catch(e){db.prepare('UPDATE documents SET status=?,updated_at=? WHERE id=?').run('failed',now(),id);out.push({id,name:f.originalname,status:'failed',error:String(e)});if(!storagePath)try{await fsp.unlink(f.path)}catch{}}}res.json(out)});
function isSafeRemoteUrl(raw:string){
 try{
   const u=new URL(raw);
   if(!['http:','https:'].includes(u.protocol))return false;
   const host=u.hostname.toLowerCase();
   if(host==='localhost'||host.endsWith('.localhost')||host==='127.0.0.1'||host==='::1'||host==='0.0.0.0')return false;
   if(/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(host))return false;
   return true;
 }catch{return false}
}
app.post('/api/documents/url',auth,async(req:any,res)=>{try{const {url,name}=req.body;if(!url)return res.status(400).json({error:'URL required'});const rawUrl=String(url).trim();if(!isSafeRemoteUrl(rawUrl))return res.status(400).json({error:'Only public HTTP/HTTPS URLs are allowed'});const u=new URL(rawUrl);const r=db.prepare('INSERT INTO documents(user_id,name,type,size,source_url,status,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(req.user.id,name||u.hostname,'text/html',0,rawUrl,'processing','',now(),now());const id=Number(r.lastInsertRowid);try{const x=await extract('', 'text/html',name||u.hostname,rawUrl);db.prepare('UPDATE documents SET content=?,status=?,updated_at=? WHERE id=?').run(x.text,'ready',now(),id);await indexDocument(id,x.text,x.pages);log(req.user.id,'url_ingested','document',id,{url:rawUrl});res.json(db.prepare('SELECT * FROM documents WHERE id=?').get(id))}catch(e){db.prepare('UPDATE documents SET status=?,updated_at=? WHERE id=?').run('failed',now(),id);throw e}}catch(e:any){res.status(422).json({error:e?.message||'Could not ingest URL'})}});
app.post('/api/documents/:id/reindex',auth,async(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});if(!d.storage_path)return res.status(400).json({error:'This source has no stored file'});let file:any;try{file=await materializeStoredFile(d.storage_path,d.name);const x=await extract(file.path,d.type,d.name);db.prepare('UPDATE documents SET content=?,status=?,updated_at=? WHERE id=?').run(x.text,'ready',now(),d.id);const n=await indexDocument(d.id,x.text,x.pages);log(req.user.id,'document_reindexed','document',d.id,{chunks:n});res.json({ok:true,chunks:n})}catch(e:any){db.prepare('UPDATE documents SET status=? WHERE id=?').run('failed',d.id);res.status(422).json({error:e?.message||'Reindex failed'})}finally{await file?.cleanup?.()}});
app.get('/api/documents/:id/file',auth,async(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d||!d.storage_path)return res.status(404).json({error:'Stored file not found'});try{await sendStoredFile(res,d.storage_path,d.name,d.type)}catch{res.status(404).json({error:'Stored file not found'})}});
app.get('/api/documents/:id',auth,(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});const chunks=db.prepare('SELECT id,chunk_index,text,page FROM chunks WHERE document_id=? ORDER BY chunk_index').all(d.id);res.json({...d,chunks})});
app.delete('/api/documents/:id',auth,async(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d)return res.status(404).json({error:'Not found'});db.prepare('DELETE FROM chunks WHERE document_id=?').run(d.id);db.prepare('DELETE FROM shares WHERE document_id=?').run(d.id);db.prepare('DELETE FROM documents WHERE id=?').run(d.id);await deleteStoredFile(d.storage_path);log(req.user.id,'document_deleted','document',d.id);res.json({ok:true})});
app.post('/api/documents/:id/assign',auth,(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});const wid=req.body.workspaceId?Number(req.body.workspaceId):null;const fid=req.body.folderId?Number(req.body.folderId):null;if(wid&&!requireWorkspace(req.user.id,wid))return res.status(403).json({error:'Workspace access denied'});db.prepare('UPDATE documents SET workspace_id=?,folder_id=?,updated_at=? WHERE id=?').run(wid,fid,now(),d.id);res.json(db.prepare('SELECT * FROM documents WHERE id=?').get(d.id))});
app.post('/api/documents/:id/share',auth,(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});const target=userByEmail(String(req.body.email||'').trim().toLowerCase());if(!target)return res.status(404).json({error:'User must have a MindVault account first'});const role=['viewer','editor'].includes(req.body.role)?req.body.role:'viewer';db.prepare('INSERT INTO shares(document_id,owner_id,shared_with_email,role,created_at) VALUES(?,?,?,?,?)').run(d.id,req.user.id,target.email,role,now());db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').run(target.id,'document_share','New document shared',`${req.user.name} shared ${d.name} with you.`,'document',d.id,now());log(req.user.id,'document_shared','document',d.id,{email:target.email,role});res.json({ok:true})});
app.get('/api/shared/documents/:id',auth,(req:any,res:any)=>{
  const id=Number(req.params.id);
  const row=db.prepare(`SELECT d.* FROM documents d JOIN shares s ON s.document_id=d.id WHERE d.id=? AND s.shared_with_email=?`).get(id,String(req.user.email).toLowerCase()) as any;
  if(!row)return res.status(404).json({error:'Shared document not found'});
  const chunks=db.prepare('SELECT id,chunk_index,text,page FROM chunks WHERE document_id=? ORDER BY chunk_index').all(id);
  res.json({...row,chunks});
});
app.get('/api/shared/documents/:id/file',auth,async(req:any,res:any)=>{
  const id=Number(req.params.id);
  const row=db.prepare(`SELECT d.storage_path,d.name,d.type FROM documents d JOIN shares s ON s.document_id=d.id WHERE d.id=? AND s.shared_with_email=?`).get(id,String(req.user.email).toLowerCase()) as any;
  if(!row||!row.storage_path)return res.status(404).json({error:'Shared file not found'});
  try{await sendStoredFile(res,row.storage_path,row.name,row.type)}catch{res.status(404).json({error:'Shared file not found'})}
});
app.get('/api/shared',auth,(req:any,res)=>{const rows=db.prepare(`SELECT s.id,s.role,s.created_at,d.id document_id,d.name,d.type,d.size,d.status,d.owner_id,u.name owner_name FROM shares s JOIN documents d ON d.id=s.document_id JOIN users u ON u.id=s.owner_id WHERE s.shared_with_email=? ORDER BY s.created_at DESC`).all(String(req.user.email).toLowerCase());res.json(rows)});
app.post('/api/documents/:id/share-link',auth,(req:any,res)=>{const d=db.prepare('SELECT id,name FROM documents WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});const existing=db.prepare('SELECT token FROM document_share_links WHERE document_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(d.id,req.user.id) as any;const token=existing?.token||makeShareToken();if(!existing)db.prepare('INSERT INTO document_share_links(document_id,user_id,token,created_at) VALUES(?,?,?,?)').run(d.id,req.user.id,token,now());res.json({token,url:`/shared/document/${token}`})});
app.get('/api/shared/document/:token',async(req,res)=>{const row=db.prepare(`SELECT l.token,d.* ,u.name owner_name FROM document_share_links l JOIN documents d ON d.id=l.document_id JOIN users u ON u.id=l.user_id WHERE l.token=?`).get(req.params.token) as any;if(!row)return res.status(404).json({error:'Shared document not found'});res.json({id:row.id,name:row.name,type:row.type,size:row.size,status:row.status,source_url:row.source_url,content:row.content,page_count:row.page_count,owner_name:row.owner_name,publicToken:row.token})});
app.get('/api/shared/document/:token/file',async(req,res)=>{const row=db.prepare(`SELECT d.storage_path,d.type,d.name FROM document_share_links l JOIN documents d ON d.id=l.document_id WHERE l.token=?`).get(req.params.token) as any;if(!row||!row.storage_path)return res.status(404).json({error:'Shared file not found'});try{await sendStoredFile(res,row.storage_path,row.name,row.type)}catch{res.status(404).json({error:'Shared file not found'})}});
app.get('/api/shared/document/:token/view',async(req,res)=>{const row=db.prepare(`SELECT d.content,d.name,d.type FROM document_share_links l JOIN documents d ON d.id=l.document_id WHERE l.token=?`).get(req.params.token) as any;if(!row)return res.status(404).json({error:'Shared document not found'});res.json(row)});


app.get('/api/search',auth,async(req:any,res)=>{
 const q=String(req.query.q||'').trim();
 if(!q)return res.json({answer:'',sources:[]});
 try{
  const rows=await retrieve(req.user.id,q,req.query.workspaceId?Number(req.query.workspaceId):undefined);
  if(!rows.length)return res.json({answer:'I could not find sufficiently relevant information in your indexed knowledge.',sources:[]});
  const sources=rows.slice(0,2).map((x:any)=>({documentId:x.document_id,name:x.name,page:x.page,type:x.type,score:x.score,snippet:cleanSourceText(String(x.text||'')).slice(0,700)}));
  const context=rows.slice(0,8).map((x:any)=>`DOCUMENT: ${x.name}${x.page?`\nPAGE: ${x.page}`:''}\nCONTENT: ${cleanSourceText(String(x.text||''))}`).join('\n\n---\n\n');
  let answer=await generate(
   'You are Mind Vault Smart Search. Synthesize the private knowledge into a fresh, accurate answer. Do not copy paragraphs. Remove OCR noise, repeated headings, unit labels, page labels and unrelated material. Start with a concise topic heading, then a direct explanation, then useful bullets. Prefer exact source facts and only add general explanation when it clarifies the source. Never invent source facts. No numeric citations or source labels. If the user asks for a diagram, provide Mermaid plus a short explanation. If the user asks for YAML, provide a fenced yaml block.',
   `Question: ${q}\n\nPrivate knowledge:\n${context}`,0.1
  );
  if(/^I’m in local-safe mode|^I could not/i.test(answer)) answer=fallbackKnowledgeAnswer(q,rows);
  res.json({answer,sources});
 }catch(e:any){res.status(200).json({answer:fallbackKnowledgeAnswer(q,[]),sources:[]})}
});

app.post('/api/ai/chat',auth,async(req:any,res:any)=>{
  const {question,conversationId,workspaceId,documentIds=[]}=req.body;
  if(!question)return res.status(400).json({error:'Question required'});
  let cid=conversationId;
  if(cid){
    const owned=db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=? AND kind=\'knowledge\'').get(cid,req.user.id);
    if(!owned)return res.status(403).json({error:'Conversation access denied'});
  }else{
    const r=db.prepare('INSERT INTO conversations(user_id,workspace_id,title,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(req.user.id,workspaceId||null,String(question).slice(0,60),'knowledge',now(),now());
    cid=Number(r.lastInsertRowid);
  }
  try{
    const ids=Array.isArray(documentIds)?documentIds.map(Number).filter(Boolean):[];
    const hits=await retrieve(req.user.id,question,workspaceId,ids.length?ids:undefined);
    const citations=hits.slice(0,2).map((h:any)=>({documentId:h.document_id,name:h.name,page:h.page,score:h.score}));
    const context=hits.slice(0,6).map((h:any)=>`SOURCE TITLE: ${h.name}${h.page?` | PAGE ${h.page}`:''}\nCONTENT:\n${String(h.text||'').slice(0,2200)}`).join('\n\n---\n\n');
    let answer='';
    try{
      answer=await generate(
        `You are MindVault Knowledge AI. Understand the user's intent even with typos, phonetic Hinglish, mixed languages, or incomplete wording. Use the supplied private vault context as the factual base, but NEVER copy source paragraphs verbatim. Synthesize a fresh answer in your own words and combine the source facts with concise general explanation when useful. Remove OCR junk, repeated phrases, headings such as Definition/Advantages/Disadvantages/Unit/Page, and irrelevant text unless it is essential. Start with a concise topic heading. Then provide a direct answer, followed by 2-6 useful key points or steps when appropriate. Use bold for important terms. If the user asks for a diagram, return a concise Mermaid diagram in a fenced mermaid block followed by a plain-language explanation. If the user asks for YAML/configuration, return a fenced yaml block. Never use numeric citations, bracketed references, page references, source labels or bibliography-like text inside the answer. If the supplied context is insufficient, say so clearly instead of guessing.`,
        `Question: ${question}\n\nPrivate vault excerpts:\n${context||'No sufficiently relevant vault content was retrieved.'}`,
        0.12
      );
    }catch(e:any){
      answer=hits.length?fallbackKnowledgeAnswer(question,hits):'I could not find sufficiently relevant information in your MindVault.';
    }
    db.prepare('INSERT INTO messages(conversation_id,role,content,citations,created_at) VALUES(?,?,?,?,?)').run(cid,'user',question,null,now());
    db.prepare('INSERT INTO messages(conversation_id,role,content,citations,created_at) VALUES(?,?,?,?,?)').run(cid,'assistant',answer,JSON.stringify(citations),now());
    db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(),cid);
    log(req.user.id,'knowledge_question','conversation',cid,{citations:citations.length,documentIds:ids});
    res.json({conversationId:cid,answer,citations,grounded:hits.length>0,ai:hasAI});
  }catch{res.status(200).json({conversationId:cid,answer:fallbackKnowledgeAnswer(question,[]),citations:[],grounded:false,ai:hasAI})}
});

function smartConversationTitle(question:string, answer:string){
  const q=String(question||'').replace(/\s+/g,' ').trim();
  const a=String(answer||'').replace(/\s+/g,' ').replace(/^#+\s*/,'').trim();
  const stop=new Set(['what','is','are','the','a','an','how','why','can','could','please','tell','me','about','explain','define','mera','hai','kya','kaise','in','of','to','for','and','or','my','your']);
  const words=q.split(/[^A-Za-z0-9+#.-]+/).filter(Boolean).filter(w=>!stop.has(w.toLowerCase()));
  const main=words.slice(0,6).join(' ');
  if(main.length>=8)return main.length>52?main.slice(0,52).replace(/\s+\S*$/,'')+'…':main;
  return (a||q).slice(0,52).replace(/\s+\S*$/,'')||'New conversation';
}

function basicAssistantFallback(question:string,memories:any[],history:any[]){
  const q=String(question||'').trim();
  if(/\b(?:who (?:made|created|built|developed)|who is (?:your )?(?:developer|creator|father)|your (?:developer|creator|father)|kisne (?:banaya|develop kiya)|tumhara (?:developer|creator|father))\b/i.test(q)) return `## Mind Vault Developer\n\n**Shubham Kumar** is the developer behind Mind Vault. He is a **4th-year B.Tech Computer Science & Engineering student at JB Institute of Technology (2023–2027)**, focused on frontend development, the MERN stack and AI-enabled web applications.\n\n### Skills\n- HTML5, CSS3, JavaScript (ES6+), React.js\n- Node.js, Express.js, MongoDB\n- Git, GitHub and Firebase authentication\n\n### Projects\n- Mind Vault — advanced AI knowledge workspace\n- Arogya AI 2.0 — AI-powered healthcare platform\n- E-commerce web application\n- Health chatbot\n- WhatsApp-style chat application\n\nHe has completed web-development, JavaScript and React learning certifications and participated in an inter-college hackathon. His strengths include quick learning, problem solving, teamwork, adaptability and communication.\n\n**GitHub:** hey-shubham\n**LinkedIn:** realshubham-dev`;
  const name=memories.find((m:any)=>m.memory_key==='name')?.memory_value;
  if(/\b(hi|hello|hey|hii|hye|namaste)\b/i.test(q)) return `## Hello! 👋\n\nI’m ready. Ask me a maths problem, coding question, study topic, planning task, or anything about Mind Vault.`;
  if(/\bwhat(?:'s| is) my name\b/i.test(q)) return name?`## Your name\n\nYour name is **${name}**.`:`## Your name\n\nI don’t have your name saved yet.`;
  const m=q.match(/^\s*(?:calculate|solve|what is)\s*([0-9\s()+\-*/%.]+)\??\s*$/i);
  if(m){try{const expr=m[1].replace(/%/g,'/100'); const result=Function(`"use strict";return (${expr})`)(); return `## Answer\n\n**${m[1].trim()} = ${result}**`; }catch{}}
  if(/how does mind vault work|what is mind vault|features of mind vault/i.test(q)) return `## Mind Vault\n\n**My Vault** stores your files. **Knowledge AI** answers from your indexed documents. **AI Assistant** handles general questions. **Search** finds and synthesizes relevant knowledge. **Study Room** creates source-grounded quizzes. **Focus Board** manages tasks.`;
  const last=history?.filter((x:any)=>x.role==='assistant').slice(-1)[0]?.content;
  if(last) return `## I’m ready\n\nI couldn’t reach the local generation engine right now, but your conversation is saved.\n\n**Last response:** ${String(last).replace(/\s+/g,' ').slice(0,420)}`;
  return `## Mind Vault AI\n\nYour request was saved, but the local model is temporarily unavailable. Your data remains in Mind Vault and the request can be retried without using a cloud API quota.`;
}

app.post('/api/ai/assistant',auth,async(req:any,res:any)=>{
  try{
    const {question,conversationId,attachmentIds=[],location,incognito=false}=req.body;
    if(!question)return res.status(400).json({error:'Question required'});
    let cid=conversationId;
    if(incognito) cid=null;
    if(cid){
      const owned=db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(cid,req.user.id);
      if(!owned)return res.status(403).json({error:'Conversation access denied'});
    }else if(!incognito){
      const r=db.prepare('INSERT INTO conversations(user_id,workspace_id,title,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(req.user.id,null,String(question).slice(0,70),'assistant',now(),now());
      cid=Number(r.lastInsertRowid);
    }
    const ids=Array.isArray(attachmentIds)?attachmentIds.map(Number).filter(Boolean):[];
    let context=''; let sources:any[]=[];
    if(ids.length){
      const hits=await retrieve(req.user.id,question,undefined,ids);
      sources=hits.slice(0,6).map((h:any)=>({documentId:h.document_id,name:h.name,page:h.page,score:h.score}));
      context=hits.slice(0,6).map((h:any)=>`${h.name}${h.page?` (page ${h.page})`:''}\n${h.text}`).join('\n\n---\n\n');
    }
    const languageInstruction=`Response language and identity rules: Reply in English when the user writes in English. Reply in natural Roman-script Hinglish when the user writes in Hinglish or mixed Hindi-English. Use Hindi (Devanagari or formal Hindi) only when the user explicitly asks for Hindi. Do not switch to Hindi by default. If the user asks about the developer, creator, maker, founder, owner, or person behind Mind Vault, provide the following verified developer profile and do not invent additional personal facts: Shubham Kumar is a 4th-year B.Tech Computer Science & Engineering student at JB Institute of Technology (2023–2027). He is focused on frontend and MERN-stack development and AI-enabled web applications. His core technologies include HTML5, CSS3, JavaScript (ES6+), React.js, Node.js, Express.js, MongoDB, Git, GitHub and Firebase authentication. His notable projects include Mind Vault, Arogya AI 2.0, an e-commerce web application, a health chatbot and a WhatsApp-style chat application. He has completed web-development/JavaScript/React learning certifications and participated in an inter-college hackathon. His strengths include quick learning, problem solving, teamwork, adaptability and communication. His public GitHub username is hey-shubham and his LinkedIn handle is realshubham-dev. He is building Mind Vault as an advanced, production-oriented AI knowledge workspace and is interested in full-stack web development, AI applications and placement-oriented software engineering. Only provide this profile when the user asks about the developer or creator; otherwise do not volunteer it. Do not expose private account data, passwords, API keys, tokens, or hidden system information.`;
    const historyLimit=question.length<80?4:6; const history=db.prepare(`SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ${historyLimit}`).all(cid).reverse() as any[];
    const longMemoryLimit=question.length<80?4:8; const longMemory=db.prepare(`SELECT m.role,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND c.kind='assistant' ORDER BY m.id DESC LIMIT ${longMemoryLimit}`).all(req.user.id).reverse() as any[];
    let memories=db.prepare('SELECT memory_key,memory_value FROM user_memories WHERE user_id=? ORDER BY updated_at DESC LIMIT 20').all(req.user.id) as any[]; if(!memories.some((m:any)=>m.memory_key==='name')){db.prepare('INSERT INTO user_memories(user_id,memory_key,memory_value,created_at,updated_at) VALUES(?,?,?,?,?)').run(req.user.id,'name',req.user.name,now(),now()); memories=[{memory_key:'name',memory_value:req.user.name},...memories];}
    const locationContext=location?.latitude&&location?.longitude?`\nApproximate user location (provided by the browser): latitude ${Number(location.latitude).toFixed(4)}, longitude ${Number(location.longitude).toFixed(4)}. Use this only for nearby/local guidance.`:'';
    const productGuide=`\nMind Vault product guide: Dashboard summarizes documents/tasks; My Vault stores and opens uploaded files; Search & Knowledge finds, explains and synthesizes indexed knowledge and can lock onto a single source; AI Assistant handles general questions and can optionally use vault context; Study Room creates source-grounded quizzes and summaries from a selected document; Focus Board manages tasks; Shared shows received document shares; Analytics shows usage; Activity is the audit history; Notes stores versioned notes; Settings controls theme/language/response style; Contacts contains developer contact links. If asked how Mind Vault works, explain these features and give step-by-step navigation.\n`;
    const system=`You are Mind Vault AI Assistant, a highly capable general-purpose AI tutor and everyday assistant. You are NOT limited to the vault. Understand typos, phonetic spellings, Hinglish, mixed languages, slang, and incomplete questions; infer the intended meaning without asking unnecessary clarification. Answer maths, science, coding, debugging, writing, translation, planning, study, interviews, brainstorming, productivity, everyday questions and explain concepts clearly. Detect the user's language and reply naturally in it. For maths, show steps and verify the result. For coding, give correct runnable code when appropriate. Structure every response with a clear answer first, then Key Points or Steps when useful, and an Example/Next Step when useful. Use markdown headings, bullets and **bold key terms**. Do not use numeric citation markers like [1]. If the user asks for a diagram, architecture, flowchart or visual explanation, provide a concise Mermaid diagram inside a fenced mermaid code block plus a plain-language explanation. If the user asks for YAML/configuration/data structure, provide a fenced yaml block. If the user asks for an image/diagram, provide the best supported visual/diagram representation and an image-generation prompt only when actual image generation is unavailable. Never claim live web access unless web data is actually provided. ${productGuide}${locationContext}${context?`\nPrivate vault context (optional):\n${context}`:''}`;
    const userPrompt=`Known user memories:\n${memories.map(m=>`${m.memory_key}: ${m.memory_value}`).join('\n')}\n\nRecent conversation messages:\n${history.map(m=>`${m.role}: ${m.content}`).join('\n')}\n\nRecent assistant-chat history from other conversations:\n${longMemory.map(m=>`${m.role}: ${m.content}`).join('\n')}\n\nUser: ${question}`;
    const nameMatch=question.match(/\b(?:my name is|i am|i'm|call me)\s+([A-Za-z][A-Za-z .'-]{1,48})/i);
    if(nameMatch){const value=nameMatch[1].trim().replace(/[.!?,]+$/,'');db.prepare('INSERT INTO user_memories(user_id,memory_key,memory_value,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,memory_key) DO UPDATE SET memory_value=excluded.memory_value,updated_at=excluded.updated_at').run(req.user.id,'name',value,now(),now());}
    const rememberMatch=question.match(/\bremember(?: that)?\s*[:,-]?\s*(.{4,180})$/i);
    if(rememberMatch){const key=`note_${Date.now()}`;db.prepare('INSERT INTO user_memories(user_id,memory_key,memory_value,created_at,updated_at) VALUES(?,?,?,?,?)').run(req.user.id,key,rememberMatch[1].trim(),now(),now());}
    if(!incognito) db.prepare('INSERT INTO messages(conversation_id,role,content,citations,created_at) VALUES(?,?,?,?,?)').run(cid,'user',question,null,now());
    let answer='';
    try{ answer=await generate(`${languageInstruction}\n\n${system}`,userPrompt,0.15); }catch(e:any){ answer=basicAssistantFallback(question,memories,history); }
    if(!incognito){ db.prepare('INSERT INTO messages(conversation_id,role,content,citations,created_at) VALUES(?,?,?,?,?)').run(cid,'assistant',answer,JSON.stringify(sources),now()); db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run(smartConversationTitle(question,answer),now(),cid); }
    log(req.user.id,'assistant_question','conversation',cid,{attachments:ids.length,location:Boolean(location)});
    res.json({conversationId:cid,answer,sources});
  }catch(e:any){res.status(200).json({conversationId:null,answer:`## AI Assistant\n\n${e?.message||'The local AI engine is temporarily unavailable.'}\n\nMind Vault avoids quota-limited cloud retries by default. Keep Ollama running with the configured local model.`,sources:[]})}
});

app.get('/api/knowledge/conversations',auth,(req:any,res)=>res.json(db.prepare("SELECT id,user_id,title,created_at,updated_at FROM conversations WHERE user_id=? AND kind='knowledge' ORDER BY updated_at DESC").all(req.user.id)));
app.delete('/api/knowledge/conversations/:id',auth,(req:any,res)=>{db.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id=? AND user_id=? AND kind='knowledge')").run(req.params.id,req.user.id);db.prepare("DELETE FROM conversation_shares WHERE conversation_id IN (SELECT id FROM conversations WHERE id=? AND user_id=? AND kind='knowledge')").run(req.params.id,req.user.id);db.prepare("DELETE FROM conversations WHERE id=? AND user_id=? AND kind='knowledge'").run(req.params.id,req.user.id);res.json({ok:true})});
app.get('/api/conversations',auth,(req:any,res)=>res.json(db.prepare("SELECT * FROM conversations WHERE user_id=? AND kind='assistant' ORDER BY pinned DESC, updated_at DESC").all(req.user.id)));
app.patch('/api/conversations/:id',auth,(req:any,res)=>{const c=db.prepare("SELECT * FROM conversations WHERE id=? AND user_id=? AND kind='assistant'").get(req.params.id,req.user.id) as any;if(!c)return res.status(404).json({error:'Conversation not found'});if(req.body.pinned!==undefined)db.prepare('UPDATE conversations SET pinned=?,updated_at=? WHERE id=?').run(req.body.pinned?1:0,now(),c.id);return res.json(db.prepare('SELECT * FROM conversations WHERE id=?').get(c.id))});
app.get('/api/conversations/:id',auth,(req:any,res)=>{const c=db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!c)return res.status(404).json({error:'Conversation not found'});res.json({conversation:c,messages:db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(req.params.id)})});
app.delete('/api/conversations/:id',auth,(req:any,res)=>{const cid=Number(req.params.id);const c=db.prepare("SELECT id FROM conversations WHERE id=? AND user_id=? AND kind='assistant'").get(cid,req.user.id) as any;if(!c)return res.status(404).json({error:'Conversation not found'});db.prepare('DELETE FROM conversation_shares WHERE conversation_id=?').run(cid);db.prepare('DELETE FROM messages WHERE conversation_id=?').run(cid);db.prepare('DELETE FROM conversations WHERE id=?').run(cid);log(req.user.id,'conversation_deleted','conversation',cid);res.json({ok:true})});
app.delete('/api/conversations',auth,(req:any,res)=>{const rows=db.prepare("SELECT id FROM conversations WHERE user_id=? AND kind='assistant'").all(req.user.id) as any[];const tx=db.transaction(()=>{for(const r of rows){db.prepare('DELETE FROM conversation_shares WHERE conversation_id=?').run(r.id);db.prepare('DELETE FROM messages WHERE conversation_id=?').run(r.id);db.prepare('DELETE FROM conversations WHERE id=?').run(r.id);}});tx();res.json({ok:true,count:rows.length})});
app.get('/api/memories',auth,(req:any,res)=>res.json(db.prepare('SELECT memory_key,memory_value,updated_at FROM user_memories WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id)));
app.delete('/api/memories/:key',auth,(req:any,res)=>{db.prepare('DELETE FROM user_memories WHERE user_id=? AND memory_key=?').run(req.user.id,String(req.params.key));res.json({ok:true})});

app.post('/api/ai/summarize',auth,async(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.body.documentId,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});const s=await generate('Summarize the supplied document. Return a clear summary with key points and important concepts.',d.content.slice(0,30000));db.prepare('UPDATE documents SET summary=?,updated_at=? WHERE id=?').run(s,now(),d.id);res.json({summary:s})});
app.post('/api/ai/topics',auth,async(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.body.documentId,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});const s=await generate('Extract 5-12 important topics from this document. Return only a JSON array of short strings.',d.content.slice(0,25000));let topics=[];try{topics=JSON.parse(s.match(/\[[\s\S]*\]/)?.[0]||'[]')}catch{topics=s.split(/\n|,/).map(x=>x.replace(/^[-*\d. ]+/,'').trim()).filter(Boolean).slice(0,12)}db.prepare('UPDATE documents SET topics=?,updated_at=? WHERE id=?').run(JSON.stringify(topics),now(),d.id);res.json({topics})});
function extractJsonArray(text:string){const m=String(text||'').match(/\[[\s\S]*\]/);if(!m)return [];try{return JSON.parse(m[0]);}catch{return []}}
function cleanQuizQuestion(v:string){return String(v||'').replace(/^(question|q)\s*\d*[:.)-]\s*/i,'').replace(/^what does\s*["“”']?definition\s*/i,'What is ').replace(/\b(?:Definition|Advantages|Disadvantages|Information Retrieved|Hinglish Explanation|Page\s*\d+|Unit\s*\d+|Chapter\s*\d+)\b[:\-]?/gi,'').replace(/\s{2,}/g,' ').replace(/\s+([?.!,])/g,'$1').trim()}
function normalizeQuiz(raw:any[],n:number){const out:any[]=[];const seen=new Set<string>();for(const q of Array.isArray(raw)?raw:[]){if(!q||typeof q.question!=='string'||!Array.isArray(q.options))continue;const question=cleanQuizQuestion(q.question);const options=[...new Set(q.options.map((x:any)=>String(x).trim()).filter((x:string)=>x.length>=2&&x.length<=160))];if(question.length<18||question.length>240||options.length!==4)continue;if(options.some((o:string)=>/^(this option|the source|not mentioned|all of the above)/i.test(o)))continue;let answer=Number(q.answer);if(!(answer>=0&&answer<4))continue;const correct=options[answer];const shuffled=options.slice();for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]}const key=question.toLowerCase();if(seen.has(key))continue;seen.add(key);out.push({question,options:shuffled,answer:shuffled.indexOf(correct),explanation:String(q.explanation||'').slice(0,420)});if(out.length>=n)break;}return out;}
function fallbackQuiz(text:string,n:number){const clean=String(text||'').replace(/\s+/g,' ').trim();const sentences=clean.split(/(?<=[.!?])\s+/).map((x:string)=>x.trim()).filter((x:string)=>x.length>60&&x.length<220);const facts=[...clean.matchAll(/\b([A-Z][A-Za-z0-9()&' -]{2,80})\s+(?:is|are|means|refers to|defined as)\s+([^.!?]{25,180})/g)].map(m=>({term:cleanQuizQuestion(m[1]),def:m[2].trim()})).filter(x=>x.term.length>2);const pool=facts.length?facts:sentences.map((x:string)=>({term:'this concept',def:x}));const picked=pool.slice().sort(()=>Math.random()-.5);const out:any[]=[];for(const f of picked){if(out.length>=n)break;const alternatives=pool.filter((x:any)=>x.def!==f.def).slice().sort(()=>Math.random()-.5).slice(0,3).map((x:any)=>x.def.slice(0,155));if(alternatives.length<3)continue;const options=[f.def,...alternatives];const shuffled=options.slice().sort(()=>Math.random()-.5);out.push({question:`Which statement most accurately describes ${f.term}?`,options:shuffled,answer:shuffled.indexOf(f.def),explanation:`This option matches the source material describing ${f.term}.`})}return out;}
app.post('/api/ai/quiz',auth,async(req:any,res:any)=>{
  const documentId=Number(req.body.documentId||0);const difficulty=['easy','medium','hard'].includes(req.body.difficulty)?req.body.difficulty:'medium';const n=Math.min(50,Math.max(1,Number(req.body.count||8)));let docs:any[]=[];
  if(documentId===0)docs=db.prepare('SELECT id,name,content FROM documents WHERE user_id=? ORDER BY created_at DESC').all(req.user.id) as any[];else {const d=db.prepare('SELECT id,name,content FROM documents WHERE id=? AND user_id=?').get(documentId,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});docs=[d]}
  if(!docs.length)return res.status(400).json({error:'No indexed sources available'});
  const corpus=docs.map(d=>`SOURCE: ${d.name}\n${String(d.content||'').slice(0,35000)}`).join('\n\n---\n\n').slice(0,140000);
  const prompt=(count:number,seed:number)=>`Create ${count} UNIQUE ${difficulty}-difficulty multiple-choice questions from the supplied study material. Question quality rules: each question must test a concrete concept from the source; use natural exam wording; vary question types (definition, purpose, comparison, process, cause/effect, application, example); NEVER copy a source heading into the question; NEVER include labels like Definition, Advantages, Unit, Page, Chapter, Information Retrieved, or raw OCR text; do not write 'according to the source' unless necessary. Each question must have exactly FOUR concise AI-written options, all plausible but only one correct, and no option may be a paragraph copied from the source. Never use filler options such as 'this option', 'not mentioned', or unrelated generic statements. Return ONLY JSON array. Batch seed ${seed}. Shape: {question,options:[4 strings],answer:0-3,explanation}.\nSTUDY MATERIAL:\n${corpus}`;
  let questions:any[]=[]; for(let batchStart=0;batchStart<n&&questions.length<n;batchStart+=10){const batch=Math.min(10,n-questions.length);try{const raw=await generate('You are an expert question writer and verifier. Ground every answer in the supplied material. Produce clean, student-friendly MCQs.',prompt(batch,batchStart),0.15);questions.push(...normalizeQuiz(extractJsonArray(raw),batch))}catch{} }
  if(questions.length<n){const retry=Math.min(10,n-questions.length);try{const raw=await generate('Generate additional non-repetitive exam-quality MCQs. Return JSON only.',prompt(retry,999),0.2);questions.push(...normalizeQuiz(extractJsonArray(raw),retry))}catch{} }
  if(questions.length<n)questions.push(...fallbackQuiz(corpus,n-questions.length));
  questions=questions.slice(0,n); if(!questions.length)return res.status(422).json({error:'Could not generate a reliable quiz from the selected material. Try a different source.'});
  const r=db.prepare('INSERT INTO quizzes(user_id,workspace_id,title,questions,created_at) VALUES(?,?,?,?,?)').run(req.user.id,null,`Quiz — ${documentId===0?'Entire vault':docs[0].name}`,JSON.stringify(questions),now());res.json({id:r.lastInsertRowid,title:`Quiz — ${documentId===0?'Entire vault':docs[0].name}`,questions});
});
app.post('/api/quizzes/:id/attempt',auth,(req:any,res)=>{const q=db.prepare('SELECT * FROM quizzes WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!q)return res.status(404).json({error:'Quiz not found'});const questions=JSON.parse(q.questions);const answers=req.body.answers||[];let score=0;questions.forEach((x:any,i:number)=>{if(Number(answers[i])===Number(x.answer))score++});db.prepare('INSERT INTO quiz_attempts(quiz_id,user_id,score,total,answers,created_at) VALUES(?,?,?,?,?,?)').run(q.id,req.user.id,score,questions.length,JSON.stringify(answers),now());res.json({score,total:questions.length,questions})});
app.post('/api/ai/flashcards',auth,async(req:any,res)=>{const d=db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(req.body.documentId,req.user.id) as any;if(!d)return res.status(404).json({error:'Document not found'});let cards:any[]=[];try{const raw=await generate('Create useful study flashcards from the source. Return ONLY JSON array of {front,back}.',d.content.slice(0,32000));cards=JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0]||'[]')}catch{}if(!cards.length){const chunks=String(d.content).split(/(?<=[.!?])\s+/).map((x:string)=>x.trim()).filter((x:string)=>x.length>55).slice(0,12);cards=chunks.map((x:string,i:number)=>({front:`What is the key idea in point ${i+1}?`,back:x}));if(!cards.length)cards=[{front:'Document',back:d.name},{front:'Main idea',back:(d.summary||d.content).slice(0,500)}]}const r=db.prepare('INSERT INTO flashcard_sets(user_id,workspace_id,title,cards,created_at) VALUES(?,?,?,?,?)').run(req.user.id,d.workspace_id,`Flashcards — ${d.name}`,JSON.stringify(cards),now());res.json({id:r.lastInsertRowid,title:`Flashcards — ${d.name}`,cards})});

app.post('/api/conversations/:id/share',auth,(req:any,res:any)=>{
  const cid=Number(req.params.id);
  const c=db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(cid,req.user.id) as any;
  if(!c)return res.status(404).json({error:'Conversation not found'});
  const existing=db.prepare('SELECT token FROM conversation_shares WHERE conversation_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(cid,req.user.id) as any;
  const token=existing?.token||makeShareToken();
  if(!existing)db.prepare('INSERT INTO conversation_shares(conversation_id,user_id,token,created_at) VALUES(?,?,?,?)').run(cid,req.user.id,token,now());
  res.json({token,url:`/shared/chat/${token}`});
});
app.get('/api/shared/chat/:token',async(req,res)=>{
  const row=db.prepare(`SELECT cs.token,c.title,c.created_at,u.name owner_name FROM conversation_shares cs JOIN conversations c ON c.id=cs.conversation_id JOIN users u ON u.id=cs.user_id WHERE cs.token=?`).get(req.params.token) as any;
  if(!row)return res.status(404).json({error:'Shared chat not found'});
  const messages=db.prepare('SELECT role,content,created_at FROM messages WHERE conversation_id=(SELECT conversation_id FROM conversation_shares WHERE token=?) ORDER BY id').all(req.params.token);
  res.json({title:row.title,owner:row.owner_name,created_at:row.created_at,messages});
});


app.get('/api/users/search',auth,(req:any,res)=>{const q=String(req.query.q||'').trim().toLowerCase();if(q.length<2)return res.json([]);const rows=db.prepare("SELECT id,email,name,username,phone,last_seen,avatar_path FROM users WHERE id<>? AND (LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR LOWER(COALESCE(username,'')) LIKE ? OR REPLACE(COALESCE(phone,''),' ','') LIKE ?) ORDER BY name LIMIT 20").all(req.user.id,`%${q}%`,`%${q}%`,`%${q}%`,`%${q.replace(/\s+/g,'')}%`);res.json(rows.map((u:any)=>safeUser(u)))});
app.get('/api/connections',auth,(req:any,res)=>{const rows=db.prepare(`SELECT c.id,u.id friend_id,u.name,u.username,u.email,u.phone,u.last_seen,u.avatar_path FROM connections c JOIN users u ON u.id=c.friend_id WHERE c.user_id=? ORDER BY u.name`).all(req.user.id);res.json(rows.map((u:any)=>({...u,avatar_url:u.avatar_path?`/api/profile/avatar/${u.friend_id}`:''}))) });
app.get('/api/connection-requests',auth,(req:any,res)=>{
 const incoming=db.prepare(`SELECT r.id,r.sender_id user_id,r.created_at,u.name,u.username,u.email,u.phone,u.last_seen,u.avatar_path FROM connection_requests r JOIN users u ON u.id=r.sender_id WHERE r.receiver_id=? AND r.status='pending' ORDER BY r.created_at DESC`).all(req.user.id) as any[];
 const outgoing=db.prepare(`SELECT r.id,r.receiver_id user_id,r.created_at,u.name,u.username,u.email,u.phone,u.last_seen,u.avatar_path FROM connection_requests r JOIN users u ON u.id=r.receiver_id WHERE r.sender_id=? AND r.status='pending' ORDER BY r.created_at DESC`).all(req.user.id) as any[];
 const map=(u:any)=>({...u,avatar_url:u.avatar_path?`/api/profile/avatar/${u.user_id}`:''});
 res.json({incoming:incoming.map(map),outgoing:outgoing.map(map)});
});
app.post('/api/connections',auth,(req:any,res)=>{
 const fid=Number(req.body.friendId);
 if(!fid||fid===req.user.id)return res.status(400).json({error:'Choose a valid connection'});
 const u=db.prepare('SELECT id,name FROM users WHERE id=?').get(fid) as any;
 if(!u)return res.status(404).json({error:'User not found'});
 if(db.prepare('SELECT 1 FROM connections WHERE user_id=? AND friend_id=?').get(req.user.id,fid))return res.status(409).json({error:'You are already connected.'});
 if(db.prepare(`SELECT 1 FROM connection_requests WHERE sender_id=? AND receiver_id=? AND status='pending'`).get(req.user.id,fid))return res.status(409).json({error:'Connection request already sent.'});
 if(db.prepare(`SELECT 1 FROM connection_requests WHERE sender_id=? AND receiver_id=? AND status='pending'`).get(fid,req.user.id))return res.status(409).json({error:'This user has already sent you a connection request. Approve it from My Connections.'});
 const existingRequest=db.prepare('SELECT id FROM connection_requests WHERE sender_id=? AND receiver_id=?').get(req.user.id,fid) as any;
 let requestId:number;
 if(existingRequest){
   db.prepare("UPDATE connection_requests SET status='pending',created_at=?,responded_at=NULL WHERE id=?").run(now(),existingRequest.id);
   requestId=Number(existingRequest.id);
 }else{
   const r=db.prepare("INSERT INTO connection_requests(sender_id,receiver_id,status,created_at) VALUES(?,?, 'pending',?)").run(req.user.id,fid,now());
   requestId=Number(r.lastInsertRowid);
 }
 db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').run(fid,'connection_request','Connection request',`${req.user.name} wants to connect with you.`,'connection_request',requestId,now());
 res.json({ok:true,requestId,status:'pending'});
});
app.post('/api/connection-requests/:id/approve',auth,(req:any,res)=>{
 const rid=Number(req.params.id);
 const r=db.prepare(`SELECT * FROM connection_requests WHERE id=? AND receiver_id=? AND status='pending'`).get(rid,req.user.id) as any;
 if(!r)return res.status(404).json({error:'Connection request not found'});
 const tx=db.transaction(()=>{
   db.prepare("UPDATE connection_requests SET status='accepted',responded_at=? WHERE id=?").run(now(),rid);
   db.prepare('INSERT OR IGNORE INTO connections(user_id,friend_id,created_at) VALUES(?,?,?)').run(req.user.id,r.sender_id,now());
   db.prepare('INSERT OR IGNORE INTO connections(user_id,friend_id,created_at) VALUES(?,?,?)').run(r.sender_id,req.user.id,now());
   db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').run(r.sender_id,'connection_accepted','Connection accepted',`${req.user.name} accepted your connection request.`,'connection',req.user.id,now());
 });
 tx();
 res.json({ok:true});
});
app.post('/api/connection-requests/:id/reject',auth,(req:any,res)=>{const rid=Number(req.params.id);const r=db.prepare(`SELECT * FROM connection_requests WHERE id=? AND receiver_id=? AND status='pending'`).get(rid,req.user.id) as any;if(!r)return res.status(404).json({error:'Connection request not found'});db.prepare("UPDATE connection_requests SET status='rejected',responded_at=? WHERE id=?").run(now(),rid);res.json({ok:true});});
app.delete('/api/connections/:id',auth,(req:any,res)=>{const fid=Number(req.params.id);db.prepare('DELETE FROM connections WHERE user_id=? AND friend_id=?').run(req.user.id,fid);db.prepare('DELETE FROM connections WHERE user_id=? AND friend_id=?').run(fid,req.user.id);res.json({ok:true})});
app.get('/api/chat/contact/:id/media',auth,(req:any,res)=>{const fid=Number(req.params.id);const media=db.prepare(`SELECT m.id,m.thread_id,m.sender_id,m.attachment_json,m.created_at FROM direct_messages m JOIN direct_members a ON a.thread_id=m.thread_id JOIN direct_members b ON b.thread_id=m.thread_id WHERE a.user_id=? AND b.user_id=? AND m.attachment_json IS NOT NULL ORDER BY m.id DESC LIMIT 100`).all(req.user.id,fid).flatMap((m:any)=>{try{return JSON.parse(m.attachment_json||'[]').map((a:any)=>({...a,messageId:m.id,created_at:m.created_at}))}catch{return[]}});res.json(media)});
app.post('/api/groups',auth,(req:any,res)=>{const name=String(req.body.name||'').trim();const members=Array.isArray(req.body.memberIds)?req.body.memberIds.map(Number).filter((x:number)=>x&&x!==req.user.id):[];if(!name||!members.length)return res.status(400).json({error:'Group name and members are required'});const r=db.prepare('INSERT INTO groups(name,owner_id,created_at,updated_at) VALUES(?,?,?,?)').run(name,req.user.id,now(),now());const gid=Number(r.lastInsertRowid);db.prepare("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?,'owner')").run(gid,req.user.id);const stmt=db.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id,role) VALUES(?,?,'member')");for(const mid of members)stmt.run(gid,mid);for(const mid of members){db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').run(mid,'group_invite',`Added to ${name}`,`${req.user.name} added you to a group.`,'group',gid,now());wsBroadcast(mid,{type:'group_invite',groupId:gid,name});}res.json({id:gid,name})});
app.delete('/api/groups/:id',auth,(req:any,res)=>{const gid=Number(req.params.id);const owner=db.prepare('SELECT 1 FROM groups WHERE id=? AND owner_id=?').get(gid,req.user.id);if(!owner)return res.status(403).json({error:'Only the group owner can delete this group'});const tx=db.transaction(()=>{db.prepare('DELETE FROM group_messages WHERE group_id=?').run(gid);db.prepare('DELETE FROM group_members WHERE group_id=?').run(gid);db.prepare('DELETE FROM groups WHERE id=?').run(gid);});tx();res.json({ok:true})});
app.get('/api/groups',auth,(req:any,res)=>{res.json(db.prepare(`SELECT g.id,g.name,g.owner_id,g.updated_at,(SELECT content FROM group_messages gm WHERE gm.group_id=g.id ORDER BY gm.id DESC LIMIT 1) last_message FROM groups g JOIN group_members m ON m.group_id=g.id AND m.user_id=? ORDER BY g.updated_at DESC`).all(req.user.id))});
app.get('/api/groups/:id/messages',auth,(req:any,res)=>{const gid=Number(req.params.id);if(!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid,req.user.id))return res.status(403).json({error:'Group access denied'});res.json(db.prepare(`SELECT gm.*,u.name sender_name FROM group_messages gm JOIN users u ON u.id=gm.sender_id WHERE gm.group_id=? ORDER BY gm.id ASC LIMIT 500`).all(gid))});
app.post('/api/groups/:id/messages',auth,(req:any,res)=>{const gid=Number(req.params.id);if(!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid,req.user.id))return res.status(403).json({error:'Group access denied'});const content=String(req.body.content||'').trim();const attachments=Array.isArray(req.body.attachments)?req.body.attachments:[];if(!content&&!attachments.length)return res.status(400).json({error:'Message is empty'});const r=db.prepare('INSERT INTO group_messages(group_id,sender_id,content,attachment_json,created_at) VALUES(?,?,?,?,?)').run(gid,req.user.id,content,attachments.length?JSON.stringify(attachments):null,now());db.prepare('UPDATE groups SET updated_at=? WHERE id=?').run(now(),gid);const message=db.prepare('SELECT gm.*,u.name sender_name FROM group_messages gm JOIN users u ON u.id=gm.sender_id WHERE gm.id=?').get(r.lastInsertRowid) as any;const members=db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(gid) as any[];for(const m of members){if(m.user_id!==req.user.id){db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').run(m.user_id,'group_message',`${req.user.name} in group`,content.slice(0,120)||'Sent an attachment','group',gid,now());wsBroadcast(m.user_id,{type:'group_message',groupId:gid,message})}}wsBroadcast(req.user.id,{type:'group_message',groupId:gid,message});res.json(message)});

app.delete('/api/chat/threads/:id',auth,(req:any,res)=>{
 const tid=Number(req.params.id);
 if(!db.prepare('SELECT 1 FROM direct_members WHERE thread_id=? AND user_id=?').get(tid,req.user.id)) return res.status(403).json({error:'Chat access denied'});
 const tx=db.transaction(()=>{db.prepare('DELETE FROM direct_messages WHERE thread_id=?').run(tid);db.prepare('DELETE FROM direct_members WHERE thread_id=?').run(tid);db.prepare('DELETE FROM direct_threads WHERE id=?').run(tid);}); tx(); res.json({ok:true});
});
app.post('/api/chat/users/:id/block',auth,(req:any,res)=>{
 const bid=Number(req.params.id); if(!bid||bid===req.user.id)return res.status(400).json({error:'Invalid user'});
 db.prepare('INSERT OR IGNORE INTO blocked_users(user_id,blocked_id,created_at) VALUES(?,?,?)').run(req.user.id,bid,now()); res.json({ok:true,blocked:true});
});
app.delete('/api/chat/users/:id/block',auth,(req:any,res)=>{const bid=Number(req.params.id);db.prepare('DELETE FROM blocked_users WHERE user_id=? AND blocked_id=?').run(req.user.id,bid);res.json({ok:true,blocked:false})});
app.get('/api/chat/users/:id/block',auth,(req:any,res)=>{const bid=Number(req.params.id);res.json({blocked:Boolean(db.prepare('SELECT 1 FROM blocked_users WHERE user_id=? AND blocked_id=?').get(req.user.id,bid))})});
app.get('/api/chat/threads',auth,(req:any,res)=>{
 const rows=db.prepare(`SELECT t.id,t.updated_at, u.id other_id,u.name other_name,u.username other_username,u.email other_email,u.phone other_phone,u.last_seen other_last_seen,u.avatar_path other_avatar_path,
 (SELECT content FROM direct_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) last_message,
 (SELECT created_at FROM direct_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) last_message_at
 FROM direct_threads t JOIN direct_members me ON me.thread_id=t.id AND me.user_id=?
 JOIN direct_members om ON om.thread_id=t.id AND om.user_id<>me.user_id JOIN users u ON u.id=om.user_id ORDER BY t.updated_at DESC`).all(req.user.id);res.json(rows)});
app.post('/api/chat/threads',auth,(req:any,res)=>{const otherId=Number(req.body.userId);if(!otherId||otherId===req.user.id)return res.status(400).json({error:'Choose another user'});const other=db.prepare('SELECT id FROM users WHERE id=?').get(otherId);if(!other)return res.status(404).json({error:'User not found'});if(db.prepare('SELECT 1 FROM blocked_users WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(req.user.id,otherId,otherId,req.user.id))return res.status(403).json({error:'This user is blocked.'});const existing=db.prepare(`SELECT t.id FROM direct_threads t JOIN direct_members m1 ON m1.thread_id=t.id AND m1.user_id=? JOIN direct_members m2 ON m2.thread_id=t.id AND m2.user_id=? LIMIT 1`).get(req.user.id,otherId) as any;if(existing)return res.json({id:existing.id});const r=db.prepare('INSERT INTO direct_threads(created_at,updated_at) VALUES(?,?)').run(now(),now());const tid=Number(r.lastInsertRowid);db.prepare('INSERT INTO direct_members(thread_id,user_id) VALUES(?,?),(?,?)').run(tid,req.user.id,tid,otherId);res.json({id:tid})});
app.get('/api/chat/threads/:id/messages',auth,(req:any,res)=>{const tid=Number(req.params.id);const member=db.prepare('SELECT 1 FROM direct_members WHERE thread_id=? AND user_id=?').get(tid,req.user.id);if(!member)return res.status(403).json({error:'Chat access denied'});db.prepare('UPDATE direct_messages SET read_at=? WHERE thread_id=? AND sender_id<>? AND read_at IS NULL').run(now(),tid,req.user.id);db.prepare(`UPDATE notifications SET seen=1 WHERE user_id=? AND type='direct_message' AND entity_type='chat' AND entity_id=?`).run(req.user.id,tid);const rows=db.prepare(`SELECT m.*,u.name sender_name FROM direct_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id=? ORDER BY m.id ASC LIMIT 300`).all(tid);res.json(rows)});
app.post('/api/chat/threads/:id/messages',auth,(req:any,res)=>{const tid=Number(req.params.id);const member=db.prepare('SELECT 1 FROM direct_members WHERE thread_id=? AND user_id=?').get(tid,req.user.id);if(!member)return res.status(403).json({error:'Chat access denied'});const other=db.prepare('SELECT user_id FROM direct_members WHERE thread_id=? AND user_id<>? LIMIT 1').get(tid,req.user.id) as any;const blocked=other&&db.prepare('SELECT 1 FROM blocked_users WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(req.user.id,Number(other.user_id),Number(other.user_id),req.user.id);if(blocked)return res.status(403).json({error:'This contact is blocked.'});const content=String(req.body.content||'').trim();const attachments=Array.isArray(req.body.attachments)?req.body.attachments:[];const replyToId=req.body.replyToId?Number(req.body.replyToId):null;if(!content&&!attachments.length)return res.status(400).json({error:'Message is empty'});const r=db.prepare('INSERT INTO direct_messages(thread_id,sender_id,content,attachment_json,reply_to_id,reaction_json,created_at) VALUES(?,?,?,?,?,?,?)').run(tid,req.user.id,content,attachments.length?JSON.stringify(attachments):null,replyToId,null,now());db.prepare('UPDATE direct_threads SET updated_at=? WHERE id=?').run(now(),tid);const message=db.prepare('SELECT m.*,u.name sender_name FROM direct_messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(r.lastInsertRowid) as any;const recipients=db.prepare('SELECT user_id FROM direct_members WHERE thread_id=? AND user_id<>?').all(tid,req.user.id) as any[];for(const x of recipients){db.prepare('INSERT INTO notifications(user_id,type,title,body,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').run(x.user_id,'direct_message',`Message from ${req.user.name}`,content.slice(0,120)||'Sent an attachment','chat',tid,now());wsBroadcast(Number(x.user_id),{type:'direct_message',threadId:tid,message})}wsBroadcast(req.user.id,{type:'direct_message',threadId:tid,message});res.json(message)});
app.get('/api/chat/messages/:id/attachment/:index/view',auth,async(req:any,res:any)=>{await serveMessageAttachment(req,res,'direct')});
app.get('/api/chat/messages/:id/attachment/:index',auth,async(req:any,res:any)=>{await serveMessageAttachment(req,res,'direct',true)});
app.get('/api/chat/notifications',auth,(req:any,res)=>{const rows=db.prepare("SELECT * FROM notifications WHERE user_id=? AND seen=0 AND type='direct_message' ORDER BY created_at DESC LIMIT 50").all(req.user.id);res.json(rows)});
app.get('/api/groups/messages/:id/attachment/:index/view',auth,async(req:any,res:any)=>{await serveMessageAttachment(req,res,'group')});
app.get('/api/groups/messages/:id/attachment/:index',auth,async(req:any,res:any)=>{await serveMessageAttachment(req,res,'group',true)});

app.get('/api/notes',auth,(req:any,res)=>{res.json(db.prepare('SELECT * FROM notes WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id))});
app.post('/api/notes',auth,(req:any,res)=>{const title=String(req.body.title||'Untitled note').trim();const content=String(req.body.content||'').trim();if(!content)return res.status(400).json({error:'Note content is required'});const r=db.prepare('INSERT INTO notes(user_id,workspace_id,title,content,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(req.user.id,null,title,content,1,now(),now());db.prepare('INSERT INTO note_versions(note_id,version,title,content,user_id,created_at) VALUES(?,?,?,?,?,?)').run(r.lastInsertRowid,1,title,content,req.user.id,now());log(req.user.id,'note_created','note',Number(r.lastInsertRowid));res.json(db.prepare('SELECT * FROM notes WHERE id=?').get(r.lastInsertRowid))});
app.patch('/api/notes/:id',auth,(req:any,res)=>{const n=db.prepare('SELECT * FROM notes WHERE id=? AND user_id=?').get(req.params.id,req.user.id) as any;if(!n)return res.status(404).json({error:'Note not found'});const title=req.body.title!==undefined?String(req.body.title||'Untitled note').trim():n.title;const content=req.body.content!==undefined?String(req.body.content||'').trim():n.content;if(!content)return res.status(400).json({error:'Note content is required'});const version=Number(n.version||1)+1;db.prepare('UPDATE notes SET title=?,content=?,version=?,updated_at=? WHERE id=?').run(title,content,version,now(),n.id);db.prepare('INSERT INTO note_versions(note_id,version,title,content,user_id,created_at) VALUES(?,?,?,?,?,?)').run(n.id,version,title,content,req.user.id,now());res.json(db.prepare('SELECT * FROM notes WHERE id=?').get(n.id))});
app.delete('/api/notes/:id',auth,(req:any,res)=>{const r=db.prepare('DELETE FROM notes WHERE id=? AND user_id=?').run(req.params.id,req.user.id);db.prepare('DELETE FROM note_versions WHERE note_id=?').run(req.params.id);if(!r.changes)return res.status(404).json({error:'Note not found'});res.json({ok:true})});
app.get('/api/analytics',auth,(req:any,res)=>{const id=req.user.id;const get=(sql:string)=>Number((db.prepare(sql).get(id) as any).n);res.json({documents:get('SELECT COUNT(*) n FROM documents WHERE user_id=?'),chunks:get('SELECT COUNT(*) n FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.user_id=?'),notes:get('SELECT COUNT(*) n FROM notes WHERE user_id=?'),conversations:get('SELECT COUNT(*) n FROM conversations WHERE user_id=?'),quizzes:get('SELECT COUNT(*) n FROM quizzes WHERE user_id=?'),flashcards:get('SELECT COUNT(*) n FROM flashcard_sets WHERE user_id=?'),tasks:get('SELECT COUNT(*) n FROM tasks WHERE user_id=?'),logs:get('SELECT COUNT(*) n FROM audit_logs WHERE user_id=?')})});
app.get('/api/activity',auth,(req:any,res)=>{const range=String(req.query.range||'all');let after:any=null;if(range==='24h')after=new Date(Date.now()-86400000).toISOString();else if(range==='7d')after=new Date(Date.now()-7*86400000).toISOString();else if(range==='30d')after=new Date(Date.now()-30*86400000).toISOString();const rows=after?db.prepare('SELECT * FROM audit_logs WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 300').all(req.user.id,after):db.prepare('SELECT * FROM audit_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 300').all(req.user.id);res.json(rows)});
app.delete('/api/activity/:id',auth,(req:any,res)=>{db.prepare('DELETE FROM audit_logs WHERE id=? AND user_id=?').run(Number(req.params.id),req.user.id);res.json({ok:true})});
app.delete('/api/activity',auth,(req:any,res)=>{const range=String(req.query.range||'all');let sql='DELETE FROM audit_logs WHERE user_id=?';const params:any[]=[req.user.id];if(range==='24h'){sql+=' AND created_at>=?';params.push(new Date(Date.now()-86400000).toISOString())}else if(range==='7d'){sql+=' AND created_at>=?';params.push(new Date(Date.now()-7*86400000).toISOString())}else if(range==='30d'){sql+=' AND created_at>=?';params.push(new Date(Date.now()-30*86400000).toISOString())}const r=db.prepare(sql).run(...params);res.json({ok:true,deleted:r.changes})});

app.use((err:any,req:any,res:any,next:any)=>{
 if(res.headersSent)return next(err);
 const status=Number(err?.status||err?.statusCode)||500;
 if(req.path?.startsWith('/api/'))return res.status(status).json({error:err?.message||'Internal server error'});
 return res.status(status).send('Internal server error');
});

app.use(express.static(path.resolve(SERVER_ROOT,'../client/dist')));
app.get('/{*splat}',(req,res,next)=>{if(req.path.startsWith('/api/'))return next();const f=path.resolve(SERVER_ROOT,'../client/dist/index.html');if(fs.existsSync(f))return res.sendFile(f);res.status(404).send('MindVault client is not built. Run npm run build.')});
httpServer.listen(PORT,()=>console.log(`MindVault server running on http://localhost:${PORT} | AI=${hasAI} | WS=/ws/chat`));

import dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {db} from './db.js';
function secret(){const value=String(process.env.JWT_SECRET||'').trim();if(value)return value;if(process.env.NODE_ENV==='production')throw new Error('JWT_SECRET must be configured in production');return 'dev-secret-change-me'}
export function hashPassword(p:string){return bcrypt.hash(p,12)}
export function comparePassword(p:string,h:string){return bcrypt.compare(p,h)}
export function sign(user:any){return jwt.sign({id:user.id,email:user.email,name:user.name},secret(),{expiresIn:'7d'})}
export function verify(token:string){return jwt.verify(token,secret()) as any}
export function auth(req:any,res:any,next:any){try{const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return res.status(401).json({error:'Authentication required'});req.user=verify(h.slice(7));next()}catch{return res.status(401).json({error:'Invalid or expired session'})}}
export function userByEmail(email:string){return db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase()) as any}
export function log(userId:number,action:string,targetType?:string,targetId?:number,metadata?:any){db.prepare('INSERT INTO audit_logs(user_id,action,target_type,target_id,metadata,created_at) VALUES(?,?,?,?,?,?)').run(userId,action,targetType||null,targetId||null,metadata?JSON.stringify(metadata):null,new Date().toISOString())}

import dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SERVER_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.join(SERVER_ROOT,'data');
fs.mkdirSync(dataDir,{recursive:true});
const databasePath=String(process.env.DATABASE_PATH||path.join(dataDir,'mindvault.db')).trim();
fs.mkdirSync(path.dirname(databasePath),{recursive:true});
export const db=new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,username TEXT,phone TEXT,avatar_path TEXT,avatar_url TEXT,created_at TEXT NOT NULL,last_seen TEXT);
CREATE TABLE IF NOT EXISTS connections(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,friend_id INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,friend_id));
CREATE TABLE IF NOT EXISTS connection_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,sender_id INTEGER NOT NULL,receiver_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,responded_at TEXT,UNIQUE(sender_id,receiver_id));
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,owner_id INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_members(group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL DEFAULT 'member',PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS group_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL,sender_id INTEGER NOT NULL,content TEXT NOT NULL DEFAULT '',attachment_json TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,owner_id INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_members(workspace_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL DEFAULT 'viewer',PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,workspace_id INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,workspace_id INTEGER,folder_id INTEGER,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,source_url TEXT,status TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',summary TEXT,topics TEXT,storage_path TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY AUTOINCREMENT,document_id INTEGER NOT NULL,chunk_index INTEGER NOT NULL,text TEXT NOT NULL,page INTEGER,embedding TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,workspace_id INTEGER,title TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS note_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,note_id INTEGER NOT NULL,version INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,user_id INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,workspace_id INTEGER,title TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'assistant',pinned INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_shares(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL,user_id INTEGER NOT NULL,token TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS document_share_links(id INTEGER PRIMARY KEY AUTOINCREMENT,document_id INTEGER NOT NULL,user_id INTEGER NOT NULL,token TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,citations TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shares(id INTEGER PRIMARY KEY AUTOINCREMENT,document_id INTEGER,workspace_id INTEGER,owner_id INTEGER NOT NULL,shared_with_email TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quizzes(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,workspace_id INTEGER,title TEXT NOT NULL,questions TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quiz_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,quiz_id INTEGER NOT NULL,user_id INTEGER NOT NULL,score INTEGER NOT NULL,total INTEGER NOT NULL,answers TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flashcard_sets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,workspace_id INTEGER,title TEXT NOT NULL,cards TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT NOT NULL,target_type TEXT,target_id INTEGER,metadata TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,due_at TEXT,priority TEXT NOT NULL DEFAULT 'medium',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_settings(user_id INTEGER PRIMARY KEY,theme TEXT NOT NULL DEFAULT 'dark',accent TEXT NOT NULL DEFAULT 'crimson',language TEXT NOT NULL DEFAULT 'auto',response_style TEXT NOT NULL DEFAULT 'balanced',updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_memories(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,memory_key TEXT NOT NULL,memory_value TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,memory_key));

CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT,entity_type TEXT,entity_id INTEGER,seen INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS direct_threads(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS direct_members(thread_id INTEGER NOT NULL,user_id INTEGER NOT NULL,PRIMARY KEY(thread_id,user_id));
CREATE TABLE IF NOT EXISTS blocked_users(user_id INTEGER NOT NULL,blocked_id INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,blocked_id));
CREATE TABLE IF NOT EXISTS otp_challenges(id INTEGER PRIMARY KEY AUTOINCREMENT,phone TEXT NOT NULL,purpose TEXT NOT NULL,provider_sid TEXT,verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS direct_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id INTEGER NOT NULL,sender_id INTEGER NOT NULL,content TEXT NOT NULL DEFAULT '',attachment_json TEXT,reply_to_id INTEGER,reaction_json TEXT,created_at TEXT NOT NULL,read_at TEXT);
`);
function ensureColumn(table:string,column:string,definition:string){const cols=db.prepare(`PRAGMA table_info(${table})`).all() as any[];if(!cols.some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)}
ensureColumn('documents','storage_path','TEXT');
ensureColumn('users','username','TEXT');
ensureColumn('users','phone','TEXT');
ensureColumn('users','avatar_path','TEXT');
ensureColumn('users','avatar_url','TEXT');
ensureColumn('users','last_seen','TEXT');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_challenges(phone,purpose,created_at)'); } catch {}

ensureColumn('tasks','priority',"TEXT NOT NULL DEFAULT 'medium'");
ensureColumn('conversations','kind',"TEXT NOT NULL DEFAULT 'assistant'");
ensureColumn('conversations','pinned','INTEGER NOT NULL DEFAULT 0');
ensureColumn('direct_messages','read_at','TEXT');
ensureColumn('direct_messages','reply_to_id','INTEGER');
ensureColumn('direct_messages','reaction_json','TEXT');
ensureColumn('users','avatar_path','TEXT');
ensureColumn('users','avatar_url','TEXT');

// Backfill and normalize usernames for databases created before username support.
// This runs before any auth query is prepared, so older v18/v19 SQLite files are upgraded safely.
try {
  const cols = db.prepare('PRAGMA table_info(users)').all() as any[];
  if (!cols.some((c:any) => c.name === 'username')) db.exec("ALTER TABLE users ADD COLUMN username TEXT");
  if (!cols.some((c:any) => c.name === 'avatar_path')) db.exec("ALTER TABLE users ADD COLUMN avatar_path TEXT");

  const rows = db.prepare('SELECT id,name,email,username FROM users ORDER BY id ASC').all() as any[];
  const used = new Set<string>();
  const makeBase = (name:string, email:string) =>
    String(name || email?.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,22) || 'user';
  const upd = db.prepare('UPDATE users SET username=? WHERE id=?');
  const tx = db.transaction(() => {
    for (const u of rows) {
      const base = makeBase(u.name, u.email);
      let candidate = String(u.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,22) || base;
      let suffix = 1;
      while (used.has(candidate)) candidate = `${base}${++suffix}`;
      if (candidate !== String(u.username || '')) upd.run(candidate, u.id);
      used.add(candidate);
    }
  });
  tx();
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'); } catch (indexErr) { console.warn('[MindVault] username index migration skipped:', String(indexErr)); }
  console.log(`[MindVault] SQLite schema ready: users.username + avatar_path present (${rows.length} users checked)`);
} catch (err) {
  console.error('[MindVault] FATAL schema migration error:', err);
  throw err;
}

try {
  db.exec(`UPDATE conversations SET kind='knowledge' WHERE id IN (SELECT target_id FROM audit_logs WHERE action='knowledge_question' AND target_id IS NOT NULL) AND id NOT IN (SELECT target_id FROM audit_logs WHERE action='assistant_question' AND target_id IS NOT NULL)`);
} catch {}

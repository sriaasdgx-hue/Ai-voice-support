import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { AppError } from './errors.js';

const missing = () => new AppError(404, 'NOT_FOUND', 'Conversation not found.');
const conflict = () => new AppError(409, 'MESSAGE_CONFLICT', 'This message ID was already used for different content.');
export class MemoryStore {
  conversations = new Map(); rows = []; seq = 0;
  async init() {}
  async close() {}
  async create(owner, settings) {
    const row = { id: randomUUID(), owner_id: owner, title: 'New conversation', settings, last_language: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.conversations.set(row.id, row); return structuredClone(row);
  }
  async get(id, owner) { const c = this.conversations.get(id); if (!c || c.owner_id !== owner) throw missing(); return structuredClone(c); }
  async list(owner) { return [...this.conversations.values()].filter(c => c.owner_id === owner).sort((a,b) => b.updated_at.localeCompare(a.updated_at)).slice(0,50).map(c => structuredClone(c)); }
  async messages(id, owner, before = Infinity) { await this.get(id,owner); return this.rows.filter(m => m.conversation_id === id && Number(m.seq) < before).slice(-100).map(m => structuredClone(m)); }
  async begin(id, owner, clientId, text, mode) {
    await this.get(id,owner);
    const existing = this.rows.find(m => m.conversation_id === id && m.client_id === clientId);
    if (existing) { if (existing.content !== text || existing.mode !== mode) throw conflict(); return { duplicate: true, user: structuredClone(existing), assistant: structuredClone(this.rows.find(m => m.conversation_id === id && m.client_id === `reply:${clientId}`)) }; }
    const make = (role, content, client_id, status) => ({ seq: String(++this.seq), id: randomUUID(), conversation_id: id, client_id, role, content, mode, status, language: null, created_at: new Date().toISOString() });
    const user = make('user',text,clientId,'completed'), assistant = make('assistant','','reply:'+clientId,'pending');
    this.rows.push(user,assistant);
    const c = this.conversations.get(id); if (c.title === 'New conversation') c.title = text.slice(0,80); c.updated_at = new Date().toISOString();
    return { duplicate: false, user: structuredClone(user), assistant: structuredClone(assistant) };
  }
  async finish(id, owner, messageId, content, status, language) {
    await this.get(id,owner); const m = this.rows.find(m => m.id === messageId && m.conversation_id === id); if (!m) throw missing();
    Object.assign(m,{content,status,language}); const c = this.conversations.get(id); if (language) c.last_language = language; c.updated_at = new Date().toISOString();
    return structuredClone(m);
  }
  async setSettings(id,owner,settings) {await this.get(id,owner);this.conversations.get(id).settings=structuredClone(settings);}
  async delete(id, owner) { await this.get(id,owner); this.conversations.delete(id); this.rows = this.rows.filter(m => m.conversation_id !== id); }
  async deleteAll(owner) { for (const c of await this.listAll(owner)) await this.delete(c.id,owner); }
  async listAll(owner) { return [...this.conversations.values()].filter(c => c.owner_id === owner); }
}

export class PostgresStore {
  constructor(config) { this.pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5, ssl: config.DATABASE_SSL === 'true' ? {rejectUnauthorized:true} : undefined, connectionTimeoutMillis:10000 }); }
  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(786734021)');
      await client.query(await readFile(new URL('../migrations/001_assistant.sql',import.meta.url),'utf8'));
      // Initial release uses one Node instance; recover turns interrupted by a restart.
      await client.query("UPDATE assistant_messages SET status='interrupted' WHERE status='pending'");
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally {client.release();}
  }
  async close() { await this.pool.end(); }
  async create(owner,settings) { return (await this.pool.query('INSERT INTO assistant_conversations(id,owner_id,title,settings) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),owner,'New conversation',settings])).rows[0]; }
  async get(id,owner) { const c = (await this.pool.query('SELECT * FROM assistant_conversations WHERE id=$1 AND owner_id=$2',[id,owner])).rows[0]; if(!c) throw missing(); return c; }
  async list(owner) { return (await this.pool.query('SELECT * FROM assistant_conversations WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 50',[owner])).rows; }
  async messages(id,owner,before=Number.MAX_SAFE_INTEGER) { await this.get(id,owner); return (await this.pool.query('SELECT * FROM (SELECT * FROM assistant_messages WHERE conversation_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT 100) latest ORDER BY seq',[id,before])).rows; }
  async begin(id,owner,clientId,text,mode) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const c = (await db.query('SELECT * FROM assistant_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner])).rows[0]; if(!c) throw missing();
      const existing = (await db.query('SELECT * FROM assistant_messages WHERE conversation_id=$1 AND client_id=$2',[id,clientId])).rows[0];
      if(existing) {
        if(existing.content !== text || existing.mode !== mode) throw conflict();
        const assistant = (await db.query('SELECT * FROM assistant_messages WHERE conversation_id=$1 AND client_id=$2',[id,'reply:'+clientId])).rows[0];
        await db.query('COMMIT'); return {duplicate:true,user:existing,assistant};
      }
      const insert = async(role,content,key,status) => (await db.query('INSERT INTO assistant_messages(id,conversation_id,client_id,role,content,mode,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),id,key,role,content,mode,status])).rows[0];
      const user = await insert('user',text,clientId,'completed'), assistant = await insert('assistant','','reply:'+clientId,'pending');
      await db.query("UPDATE assistant_conversations SET title=CASE WHEN title='New conversation' THEN $2 ELSE title END, updated_at=now() WHERE id=$1",[id,text.slice(0,80)]);
      await db.query('COMMIT'); return {duplicate:false,user,assistant};
    } catch(e) {await db.query('ROLLBACK');throw e;} finally {db.release();}
  }
  async finish(id,owner,messageId,content,status,language) {
    await this.get(id,owner);
    const row = (await this.pool.query('UPDATE assistant_messages SET content=$1,status=$2,language=$3 WHERE id=$4 AND conversation_id=$5 RETURNING *',[content,status,language,messageId,id])).rows[0];
    if(!row) throw missing();
    await this.pool.query('UPDATE assistant_conversations SET last_language=COALESCE($2,last_language),updated_at=now() WHERE id=$1 AND owner_id=$3',[id,language,owner]); return row;
  }
  async setSettings(id,owner,settings) {const r=await this.pool.query('UPDATE assistant_conversations SET settings=$1 WHERE id=$2 AND owner_id=$3',[settings,id,owner]);if(!r.rowCount)throw missing();}
  async delete(id,owner) {const r=await this.pool.query('DELETE FROM assistant_conversations WHERE id=$1 AND owner_id=$2',[id,owner]);if(!r.rowCount) throw missing();}
  async deleteAll(owner) {await this.pool.query('DELETE FROM assistant_conversations WHERE owner_id=$1',[owner]);}
}

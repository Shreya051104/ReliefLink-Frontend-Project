import express from 'express';
import { MongoClient } from 'mongodb';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const app = express();
const PORT = Number(process.env.PORT || 4000);
const DATA_DIR = path.join(__dirname, 'data');
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'workspace.json');
const DATABASE_FILE = process.env.RELIEFLINK_DB_PATH ? path.resolve(process.env.RELIEFLINK_DB_PATH) : path.join(DATA_DIR, 'relieflink.sqlite');
const EMPTY = { incidents: [], needs: [], offers: [], pledges: [], beneficiaryRequests: [], ngoProfiles: [], userProfiles: [], updatedAt: null };
const COLLECTIONS = ['incidents', 'needs', 'offers', 'pledges', 'beneficiaryRequests', 'ngoProfiles', 'userProfiles'];
const OFFICIAL_SOURCES = [
  { id: 'ndma', name: 'National Disaster Management Authority', type: 'Disaster guidance', url: 'https://ndma.gov.in/', access: 'Official portal; public reference' },
  { id: 'ndem', name: 'National Database for Emergency Management (NRSC/ISRO)', type: 'Disaster information', url: 'https://ndem.nrsc.gov.in/', access: 'Official portal; some services may require access' },
  { id: 'imd', name: 'India Meteorological Department', type: 'Weather alerts', url: 'https://mausam.imd.gov.in/', access: 'Official portal; public alerts and forecasts' },
  { id: 'sachet', name: 'SACHET National Disaster Alert Portal', type: 'Public alerts', url: 'https://sachet.ndma.gov.in/', access: 'Official portal; service availability may vary' },
  { id: 'ngodarpan', name: 'NGO Darpan (NITI Aayog)', type: 'NGO registration lookup', url: 'https://ngodarpan.gov.in/', access: 'Official registry portal; this app does not query its private systems' },
  { id: 'datagov', name: 'Open Government Data Platform India', type: 'Open datasets / API', url: 'https://www.data.gov.in/', access: 'API access requires a registered key and a selected dataset' }
];

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(path.dirname(DATABASE_FILE), { recursive: true });
const database = new DatabaseSync(DATABASE_FILE);
let mongoClient;
let mongoDb;
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS workspace_records (
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (collection, record_id)
  );
  CREATE TABLE IF NOT EXISTS workspace_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

async function importLegacyWorkspace() {
  const priorState = database.prepare("SELECT value FROM workspace_meta WHERE key IN ('legacyImported', 'updatedAt') LIMIT 1").get();
  const recordCount = database.prepare('SELECT COUNT(*) AS count FROM workspace_records').get().count;
  if (priorState || recordCount > 0) {
    database.prepare("INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('legacyImported', 'true')").run();
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  let legacy;
  try {
    legacy = JSON.parse(await fs.readFile(LEGACY_DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (legacy !== undefined) {
    const imported = cleanState(legacy);
    if (COLLECTIONS.some(key => imported[key].length > 0)) writeState(imported);
  }
  database.prepare("INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('legacyImported', 'true')").run();
}

function readState() {
  const state = structuredClone(EMPTY);
  const rows = database.prepare('SELECT collection, payload FROM workspace_records ORDER BY collection, position').all();
  for (const row of rows) state[row.collection].push(JSON.parse(row.payload));
  state.updatedAt = database.prepare("SELECT value FROM workspace_meta WHERE key = 'updatedAt'").get()?.value || null;
  return state;
}

function cleanState(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Workspace must be a JSON object.');
  const state = { ...EMPTY };
  for (const key of COLLECTIONS) {
    if (body[key] !== undefined && !Array.isArray(body[key])) throw new TypeError(`${key} must be an array.`);
    state[key] = body[key] || [];
    const ids = new Set();
    for (const record of state[key]) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !['string', 'number'].includes(typeof record.id) || !String(record.id).trim()) {
        throw new TypeError(`Every ${key} record must have an id.`);
      }
      if (ids.has(String(record.id))) throw new TypeError(`${key} contains a duplicate record id.`);
      ids.add(String(record.id));
    }
  }
  return state;
}

function writeState(state) {
  state.updatedAt = new Date().toISOString();
  const insert = database.prepare('INSERT INTO workspace_records (collection, record_id, position, payload) VALUES (?, ?, ?, ?)');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM workspace_records');
    for (const key of COLLECTIONS) {
      state[key].forEach((record, position) => insert.run(key, String(record.id), position, JSON.stringify(record)));
    }
    database.prepare("INSERT INTO workspace_meta (key, value) VALUES ('updatedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(state.updatedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return state;
}

function applySqliteChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Changes must be a JSON object.');
  const state = readState();
  const upsert = database.prepare('INSERT INTO workspace_records (collection, record_id, position, payload) VALUES (?, ?, ?, ?) ON CONFLICT(collection, record_id) DO UPDATE SET position = excluded.position, payload = excluded.payload');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const key of COLLECTIONS) {
      const change = changes[key];
      if (change === undefined) continue;
      if (!change || !Array.isArray(change.upsert) || !Array.isArray(change.delete) || !Array.isArray(change.order)) {
        throw new TypeError(`${key} changes must include upsert, delete, and order arrays.`);
      }
      const records = new Map(state[key].map(record => [String(record.id), record]));
      for (const id of change.delete) {
        if (typeof id !== 'string' || !id) throw new TypeError(`${key} delete IDs must be non-empty strings.`);
        records.delete(id);
      }
      for (const record of change.upsert) {
        if (!record || typeof record !== 'object' || Array.isArray(record) || !['string', 'number'].includes(typeof record.id) || !String(record.id).trim()) {
          throw new TypeError(`Every ${key} change must include a record id.`);
        }
        records.set(String(record.id), record);
      }
      const order = [];
      const seen = new Set();
      for (const id of change.order) {
        if (typeof id !== 'string' || seen.has(id)) continue;
        if (records.has(id)) order.push(id);
        seen.add(id);
      }
      for (const id of records.keys()) if (!seen.has(id)) order.push(id);
      state[key] = order.map(id => records.get(id));
      database.prepare('DELETE FROM workspace_records WHERE collection = ?').run(key);
      state[key].forEach((record, position) => upsert.run(key, String(record.id), position, JSON.stringify(record)));
    }
    state.updatedAt = new Date().toISOString();
    database.prepare("INSERT INTO workspace_meta (key, value) VALUES ('updatedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(state.updatedAt);
    database.exec('COMMIT');
    return state;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function mergeChanges(state, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Changes must be a JSON object.');
  for (const key of COLLECTIONS) {
    const change = changes[key];
    if (change === undefined) continue;
    if (!change || !Array.isArray(change.upsert) || !Array.isArray(change.delete) || !Array.isArray(change.order)) {
      throw new TypeError(`${key} changes must include upsert, delete, and order arrays.`);
    }
    const records = new Map(state[key].map(record => [String(record.id), record]));
    for (const id of change.delete) {
      if (typeof id !== 'string' || !id) throw new TypeError(`${key} delete IDs must be non-empty strings.`);
      records.delete(id);
    }
    for (const record of change.upsert) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !['string', 'number'].includes(typeof record.id) || !String(record.id).trim()) {
        throw new TypeError(`Every ${key} change must include a record id.`);
      }
      records.set(String(record.id), record);
    }
    const order = [];
    const seen = new Set();
    for (const id of change.order) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (records.has(id)) order.push(id);
      seen.add(id);
    }
    for (const id of records.keys()) if (!seen.has(id)) order.push(id);
    state[key] = order.map(id => records.get(id));
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

async function readMongoState(session) {
  const state = structuredClone(EMPTY);
  const records = await mongoDb.collection('workspace_records').find({}, { session }).sort({ collection: 1, position: 1 }).toArray();
  for (const record of records) state[record.collection].push(record.payload);
  const metadata = await mongoDb.collection('workspace_meta').findOne({ _id: 'workspace' }, { session });
  state.updatedAt = metadata?.updatedAt || null;
  return state;
}

async function writeMongoState(state, session) {
  state.updatedAt = new Date().toISOString();
  const records = COLLECTIONS.flatMap(collection => state[collection].map((payload, position) => ({
    collection,
    record_id: String(payload.id),
    position,
    payload
  })));
  const options = session ? { session } : {};
  await mongoDb.collection('workspace_records').deleteMany({}, options);
  if (records.length) await mongoDb.collection('workspace_records').insertMany(records, { ...options, ordered: true });
  await mongoDb.collection('workspace_meta').updateOne(
    { _id: 'workspace' },
    { $set: { updatedAt: state.updatedAt } },
    { ...options, upsert: true }
  );
  return state;
}

async function initializeMongoStorage() {
  if (!process.env.MONGODB_URI) return;
  mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB_NAME || 'relieflink');
  await mongoDb.collection('workspace_records').createIndex({ collection: 1, record_id: 1 }, { unique: true });

  const session = mongoClient.startSession();
  try {
    await session.withTransaction(async () => {
      const meta = mongoDb.collection('workspace_meta');
      const migration = await meta.findOne({ _id: 'sqliteMigration' }, { session });
      if (migration) return;
      const records = mongoDb.collection('workspace_records');
      const cloudCount = await records.countDocuments({}, { session });
      const localState = readState();
      const localRecords = COLLECTIONS.flatMap(collection => localState[collection].map((payload, position) => ({
        collection,
        record_id: String(payload.id),
        position,
        payload
      })));
      let importedCount = 0;
      if (cloudCount === 0 && localRecords.length) {
        await records.insertMany(localRecords, { session, ordered: true });
        importedCount = localRecords.length;
        if (localState.updatedAt) await meta.updateOne({ _id: 'workspace' }, { $set: { updatedAt: localState.updatedAt } }, { session, upsert: true });
      }
      await meta.insertOne({ _id: 'sqliteMigration', completedAt: new Date().toISOString(), importedCount }, { session });
    });
  } finally {
    await session.endSession();
  }
}

async function getWorkspaceState() {
  return mongoDb ? readMongoState() : readState();
}

async function saveWorkspaceState(state) {
  if (!mongoDb) return writeState(state);
  const session = mongoClient.startSession();
  try {
    let saved;
    await session.withTransaction(async () => { saved = await writeMongoState(state, session); });
    return saved;
  } finally {
    await session.endSession();
  }
}

async function synchronizeWorkspaceChanges(changes) {
  if (!mongoDb) return applySqliteChanges(changes);
  const session = mongoClient.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      updated = mergeChanges(await readMongoState(session), changes);
      await writeMongoState(updated, session);
    });
    return updated;
  } finally {
    await session.endSession();
  }
}

await importLegacyWorkspace();
try {
  await initializeMongoStorage();
} catch (error) {
  console.error('Could not connect to MongoDB Atlas or migrate the local SQLite data. Check MONGODB_URI and Atlas network access.', error);
  await mongoClient?.close();
  throw error;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ReliefLink India API', database: mongoDb ? 'mongodb-atlas' : 'sqlite' }));
app.get('/api/sources', (_req, res) => res.json({ sources: OFFICIAL_SOURCES, liveDataConnected: false }));
app.get('/api/state', async (_req, res) => {
  try { res.json(await getWorkspaceState()); } catch (error) { console.error('Could not read workspace data:', error); res.status(500).json({ error: 'Could not read workspace data.' }); }
});
app.put('/api/state', async (req, res) => {
  let clean;
  try { clean = cleanState(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  try { res.json(await saveWorkspaceState(clean)); } catch (error) { console.error('Could not save workspace data:', error); res.status(500).json({ error: 'Could not save workspace data.' }); }
});
app.patch('/api/state', async (req, res) => {
  try { res.json(await synchronizeWorkspaceChanges(req.body)); } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: error.message });
    console.error('Could not synchronize workspace changes:', error);
    res.status(500).json({ error: 'Could not synchronize workspace changes.' });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => console.log(`ReliefLink India running at http://localhost:${PORT}`));

// Online storage for the Vercel deployment. Everything lives in one private Blob,
// db/state.json = { rev, funcionarios: {id: doc}, avaliacoes: {id: doc} }, so a refresh
// costs one read no matter how many records there are. Writes are read-modify-write
// guarded by the blob's ETag, so two devices saving at once never drop each other's
// changes. Every request must carry the shared access password (APP_PASSWORD) in x-senha.
import { timingSafeEqual } from 'node:crypto';
import { BlobPreconditionFailedError, get, list, put } from '@vercel/blob';

const COLECOES = ['funcionarios', 'avaliacoes'];
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_DOC = 200 * 1024;
const STATE = 'db/state.json';
const MEM_TTL = 20_000;

// Per-instance copy of the state; a warm instance answers polls without touching Blob.
let mem = null; // { state, etag, at }

function senhaOk(req) {
  const esperada = process.env.APP_PASSWORD || '';
  const enviada = String(req.headers['x-senha'] || '');
  if (!esperada || !enviada) return false;
  const a = Buffer.from(esperada), b = Buffer.from(enviada);
  return a.length === b.length && timingSafeEqual(a, b);
}

const vazio = () => ({ rev: 0, funcionarios: {}, avaliacoes: {} });

async function lerJson(pathname, useCache) {
  const r = await get(pathname, { access: 'private', useCache });
  if (!r || r.statusCode !== 200) return null;
  return { json: JSON.parse(await new Response(r.stream).text()), etag: r.blob.etag };
}

// One-time move from the first version, which kept one blob per record under data/.
// The old blobs are left in place as a backup.
async function migrarLegado() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: 'data/', cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const state = vazio();
  for (const b of blobs) {
    const col = b.pathname.split('/')[1];
    if (!COLECOES.includes(col)) continue;
    try { const d = await lerJson(b.pathname, false); if (d?.json?.id) state[col][d.json.id] = d.json; } catch {}
  }
  state.rev = 1;
  try {
    const r = await put(STATE, JSON.stringify(state), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 });
    return { state, etag: r.etag };
  } catch {
    // Another request migrated first; use what it wrote.
    const d = await lerJson(STATE, false);
    return { state: d.json, etag: d.etag };
  }
}

// fresh=true reads origin (for writes); fresh=false may use this instance's copy or the CDN.
async function lerEstado(fresh) {
  if (!fresh && mem && Date.now() - mem.at < MEM_TTL) return mem;
  const d = await lerJson(STATE, !fresh);
  const atual = d ? { state: d.json, etag: d.etag } : await migrarLegado();
  // Never let a cached CDN copy move us backwards.
  if (!fresh && mem && mem.state.rev > atual.state.rev) { mem.at = Date.now(); return mem; }
  mem = { ...atual, at: Date.now() };
  return mem;
}

async function gravar(mudar) {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { state, etag } = await lerEstado(true);
    const proximo = structuredClone(state);
    const res = mudar(proximo);
    if (res && res.erro) return res;
    proximo.rev = (state.rev || 0) + 1;
    try {
      const r = await put(STATE, JSON.stringify(proximo), {
        access: 'private', contentType: 'application/json', addRandomSuffix: false,
        allowOverwrite: true, ifMatch: etag, cacheControlMaxAge: 60,
      });
      mem = { state: proximo, etag: r.etag, at: Date.now() };
      return { ok: true, rev: proximo.rev };
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || /precondition/i.test(String(e?.message))) {
        await new Promise(r => setTimeout(r, 80 + Math.random() * 200));
        continue;
      }
      throw e;
    }
  }
  return { erro: 'Muitas gravações ao mesmo tempo. Tente de novo.', status: 503 };
}

function lerCorpo(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Health check without data: confirms the function, the password and the Blob store are configured.
  if (req.method === 'GET' && req.query.saude !== undefined) {
    try { await list({ prefix: 'db/', limit: 1 }); }
    catch (e) { return res.status(500).json({ ok: false, armazenamento: false, senhaConfigurada: !!process.env.APP_PASSWORD }); }
    return res.status(200).json({ ok: true, armazenamento: true, senhaConfigurada: !!process.env.APP_PASSWORD });
  }
  if (!process.env.APP_PASSWORD) return res.status(500).json({ erro: 'APP_PASSWORD não configurada no projeto.' });
  if (!senhaOk(req)) return res.status(401).json({ erro: 'Senha de acesso inválida.' });

  try {
    if (req.method === 'GET') {
      const { state } = await lerEstado(false);
      if (req.query.rev !== undefined && String(req.query.rev) === String(state.rev)) return res.status(200).json({ rev: state.rev, igual: true });
      return res.status(200).json({ rev: state.rev, funcionarios: Object.values(state.funcionarios), avaliacoes: Object.values(state.avaliacoes) });
    }

    const col = String(req.query.col || '');
    const id = String(req.query.id || '');
    if (!COLECOES.includes(col) || !ID_RE.test(id)) return res.status(400).json({ erro: 'Coleção ou identificador inválido.' });

    if (req.method === 'PUT') {
      const body = lerCorpo(req);
      const doc = body && typeof body.doc === 'object' && !Array.isArray(body.doc) ? body.doc : null;
      if (!doc) return res.status(400).json({ erro: 'O corpo precisa ter o documento em "doc".' });
      const json = JSON.stringify({ ...doc, id });
      if (Buffer.byteLength(json) > MAX_DOC) return res.status(413).json({ erro: 'Documento grande demais.' });
      const base = body.base ?? null;
      const r = await gravar(state => {
        const atual = state[col][id];
        // Someone else saved this record after this device loaded it.
        if (!body.force && atual && (atual.atualizadoEm ?? null) !== base) return { erro: 'conflito', status: 409, atual };
        state[col][id] = JSON.parse(json);
      });
      if (r.erro) return res.status(r.status || 500).json(r);
      return res.status(200).json(r);
    }

    if (req.method === 'DELETE') {
      const r = await gravar(state => { delete state[col][id]; });
      if (r.erro) return res.status(r.status || 500).json(r);
      return res.status(200).json(r);
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ erro: 'Método não permitido.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Falha no armazenamento. Tente de novo.' });
  }
}

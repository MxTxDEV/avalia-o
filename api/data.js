// Online storage for the Vercel deployment: one private Blob per document,
// at data/<colecao>/<id>.json. Every request must carry the shared access
// password (APP_PASSWORD) in the x-senha header.
import { timingSafeEqual } from 'node:crypto';
import { del, get, list, put } from '@vercel/blob';

const COLECOES = new Set(['funcionarios', 'avaliacoes']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BYTES = 200 * 1024;

function senhaOk(req) {
  const esperada = process.env.APP_PASSWORD || '';
  const enviada = String(req.headers['x-senha'] || '');
  if (!esperada || !enviada) return false;
  const a = Buffer.from(esperada), b = Buffer.from(enviada);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function lerDoc(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  try { return JSON.parse(await new Response(r.stream).text()); } catch { return null; }
}

async function lerTudo() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: 'data/', cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  const out = { funcionarios: [], avaliacoes: [] };
  const fila = [...blobs];
  const worker = async () => {
    while (fila.length) {
      const b = fila.shift();
      const [, col] = b.pathname.split('/');
      if (!COLECOES.has(col)) continue;
      const doc = await lerDoc(b.pathname);
      if (doc && typeof doc === 'object') out[col].push(doc);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.APP_PASSWORD) return res.status(500).json({ erro: 'APP_PASSWORD não configurada no projeto.' });
  if (!senhaOk(req)) return res.status(401).json({ erro: 'Senha de acesso inválida.' });

  try {
    if (req.method === 'GET') return res.status(200).json(await lerTudo());

    const col = String(req.query.col || '');
    const id = String(req.query.id || '');
    if (!COLECOES.has(col) || !ID_RE.test(id)) return res.status(400).json({ erro: 'Coleção ou identificador inválido.' });
    const pathname = `data/${col}/${id}.json`;

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ erro: 'O corpo precisa ser um objeto JSON.' });
      const doc = { ...body, id };
      const json = JSON.stringify(doc);
      if (Buffer.byteLength(json) > MAX_BYTES) return res.status(413).json({ erro: 'Documento grande demais.' });
      await put(pathname, json, { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const page = await list({ prefix: pathname, limit: 10 });
      const alvo = page.blobs.filter(b => b.pathname === pathname).map(b => b.url);
      if (alvo.length) await del(alvo);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ erro: 'Método não permitido.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Falha no armazenamento. Tente de novo.' });
  }
}

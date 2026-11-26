import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { crearServidor } from '../src/servidor.js';
import { leerConfig } from '../src/wp.js';

function claveValida(recibida: string | null): boolean {
  const esperada = process.env.MCP_CLAVE ?? '';
  if (esperada.length < 24 || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (res: ServerResponse, estado: number, cuerpo: unknown) => {
  res.statusCode = estado;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(cuerpo));
};

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!claveValida(url.searchParams.get('clave'))) return json(res, 401, { error: 'No autorizado' });
  if (req.method !== 'POST') {
    return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Solo POST' }, id: null });
  }
  try {
    const servidor = crearServidor(leerConfig());
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transporte.close(); servidor.close(); });
    await servidor.connect(transporte);
    await transporte.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('error', e instanceof Error ? e.message : e);
    if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
  }
}

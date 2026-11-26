// WordPress simulado + cliente MCP real: comprueba herramientas, confirmaciones y niveles.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { crearServidor } from '../src/servidor.js';
import handler from '../api/mcp.js';

const llamadas: string[] = [];
let plugins = [{ plugin: 'wordpress-seo/wp-seo', name: 'Yoast SEO', status: 'active', version: '23' }, { plugin: 'hello/hello', name: 'Hola', status: 'inactive', version: '1' }];
const papelera = [{ id: 7 }, { id: 8 }];

const wpFalso = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  llamadas.push(`${req.method} ${u.pathname}${u.search.includes('force') ? '?force' : ''}`);
  const auth = req.headers.authorization;
  const j = (c: number, b: unknown, h: Record<string, string> = {}) => { res.writeHead(c, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(b)); };
  if (u.pathname === '/huella') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>Huella</title></head><body><h1>A</h1><h1>B</h1><img src="a.png"></body></html>'); }
  if (!auth?.startsWith('Basic ')) return j(401, { code: 'rest_forbidden', message: 'no' });
  const p = u.pathname;
  if (p === '/wp-json/') return j(200, { name: 'GI', description: 'x', url: 'http://x' });
  if (p === '/wp-json/wp/v2/users/me') return j(200, { id: 1, name: 'comms', roles: ['editor'] });
  if (p === '/wp-json/wp/v2/types') return j(200, { post: { slug: 'post', name: 'Entradas', rest_base: 'posts', taxonomies: [] }, gi_expertise: { slug: 'gi_expertise', name: 'Expertise', rest_base: 'gi_expertise', taxonomies: [] } });
  if (p === '/wp-json/wp/v2/plugins' && req.method === 'GET') return j(200, plugins);
  if (p.startsWith('/wp-json/wp/v2/plugins/') && req.method === 'POST') { plugins[1].status = 'active'; return j(200, plugins[1]); }
  if (p === '/wp-json/wp/v2/gi_expertise' && req.method === 'GET') {
    if (u.searchParams.get('status') === 'trash') return j(200, papelera, { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' });
    return j(200, [{ id: 1, title: { raw: 'Huella de carbono' }, status: 'publish', slug: 'huella', link: 'http://localhost:' + (wpFalso.address() as any).port + '/huella', modified: '2026-11-01' }], { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' });
  }
  if (p === '/wp-json/wp/v2/gi_expertise/1' && req.method === 'POST') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => j(200, { id: 1, status: 'publish', modified: 'ahora', link: 'x' })); return; }
  if (/\/wp-json\/wp\/v2\/gi_expertise\/\d+$/.test(p) && req.method === 'DELETE') return j(200, { deleted: true });
  j(404, { code: 'rest_no_route', message: 'no existe' });
});

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'FALLA'), m); if (!c) fallos++; };

wpFalso.listen(0, async () => {
  const puerto = (wpFalso.address() as any).port;
  // El cliente exige https: se apunta a http local cambiando la URL ya validada.
  const mk = async (nivel: string) => {
    const srv = crearServidor({ url: `http://127.0.0.1:${puerto}`, usuario: 'u', clave: 'k', nivel: nivel as any });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '1' });
    await Promise.all([srv.connect(a), c.connect(b)]);
    return c;
  };
  const txt = (r: any) => r.content[0].text as string;

  const c = await mk('completo');
  const tools = (await c.listTools()).tools.map((t) => t.name);
  ok(tools.length >= 20, `expone ${tools.length} herramientas`);

  ok(txt(await c.callTool({ name: 'wp_listar', arguments: { tipo: 'gi_expertise' } })).includes('Huella de carbono'), 'listar CPT gi_expertise');
  ok(txt(await c.callTool({ name: 'wp_actualizar', arguments: { tipo: 'gi_expertise', id: 1, campos: { status: 'publish' } } })).startsWith('VISTA PREVIA'), 'publicar sin confirmar solo da vista previa');
  ok(!llamadas.includes('POST /wp-json/wp/v2/gi_expertise/1'), '…y no llamó a WordPress');
  ok(txt(await c.callTool({ name: 'wp_actualizar', arguments: { tipo: 'gi_expertise', id: 1, campos: { title: 'Nuevo' } } })).includes('"id": 1'), 'editar título directo');
  ok(txt(await c.callTool({ name: 'wp_plugin_estado', arguments: { plugin: 'hello/hello', estado: 'active' } })).startsWith('VISTA PREVIA'), 'plugin sin confirmar: vista previa');
  ok(plugins[1].status === 'inactive', '…plugin sigue inactivo');
  ok(txt(await c.callTool({ name: 'wp_plugin_estado', arguments: { plugin: 'hello/hello', estado: 'active', confirmar: true } })).includes('active'), 'plugin con confirmar se activa');
  ok(txt(await c.callTool({ name: 'wp_plugin_estado', arguments: { plugin: '../x', estado: 'active', confirmar: true } })).includes('no válid'), 'rechaza nombre de plugin raro');
  ok(txt(await c.callTool({ name: 'wp_limpieza_ejecutar', arguments: { accion: 'papelera', tipo: 'gi_expertise' } })).includes('2 elemento'), 'limpieza: vista previa cuenta 2');
  const l = await c.callTool({ name: 'wp_limpieza_ejecutar', arguments: { accion: 'papelera', tipo: 'gi_expertise', confirmar: true } });
  ok(txt(l).includes('"borrados": 2') && llamadas.includes('DELETE /wp-json/wp/v2/gi_expertise/7?force'), 'limpieza confirmada borra con force');
  const seo = txt(await c.callTool({ name: 'wp_seo_url', arguments: { url: `http://127.0.0.1:${puerto}/huella` } }));
  ok(seo.includes('2 H1') && seo.includes('sin meta description') && seo.includes('sin alt'), 'auditoría SEO detecta H1 doble, sin description, sin alt');
  ok(txt(await c.callTool({ name: 'wp_seo_url', arguments: { url: 'https://otro-sitio.com/' } })).includes('no pertenece'), 'SEO rechaza URL de otro dominio (anti-SSRF)');
  const r = await c.callTool({ name: 'wp_rest', arguments: { ruta: '/wp/v2/../settings' } });
  ok(!!r.isError, 'wp_rest rechaza rutas con ..');
  ok(txt(await c.callTool({ name: 'wp_rest', arguments: { metodo: 'POST', ruta: '/wp/v2/settings', cuerpo: { title: 'x' } } })).startsWith('VISTA PREVIA'), 'wp_rest: ajustes pide confirmación');

  const lect = await mk('lectura');
  const n1 = await lect.callTool({ name: 'wp_actualizar', arguments: { tipo: 'gi_expertise', id: 1, campos: { title: 'x' } } });
  ok(!!n1.isError && txt(n1).includes('nivel lectura'), 'nivel lectura bloquea edición');
  const ed = await mk('edicion');
  const n2 = await ed.callTool({ name: 'wp_plugin_estado', arguments: { plugin: 'hello/hello', estado: 'inactive', confirmar: true } });
  ok(!!n2.isError, 'nivel edicion bloquea plugins');

  // Endpoint HTTP: clave en la dirección
  process.env.MCP_CLAVE = 'k'.repeat(30);
  process.env.WP_URL = 'https://ejemplo.test'; process.env.WP_USUARIO = 'u'; process.env.WP_CLAVE_APP = 'p';
  const web = http.createServer((q, s) => (handler as any)(q, s));
  await new Promise<void>((r) => web.listen(0, r));
  const wp_ = (web.address() as any).port;
  const peticion = (clave: string) => fetch(`http://127.0.0.1:${wp_}/api/mcp?clave=${clave}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  ok((await peticion('mala')).status === 401, 'endpoint: clave incorrecta → 401');
  const buena = await peticion('k'.repeat(30));
  const cuerpo = await buena.text();
  ok(buena.status === 200 && cuerpo.includes('wp_listar'), 'endpoint: clave correcta lista herramientas');

  console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en orden');
  web.close(); wpFalso.close(); process.exit(fallos ? 1 : 0);
});

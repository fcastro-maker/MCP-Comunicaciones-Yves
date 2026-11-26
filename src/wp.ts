// Cliente mínimo de la REST API de WordPress + reglas de seguridad del conector.

export type Nivel = 'lectura' | 'edicion' | 'completo';

export interface Config {
  url: string;
  usuario: string;
  clave: string;
  nivel: Nivel;
}

export function leerConfig(env: Record<string, string | undefined> = process.env): Config {
  const url = (env.WP_URL ?? '').trim().replace(/\/+$/, '');
  const usuario = (env.WP_USUARIO ?? '').trim();
  const clave = (env.WP_CLAVE_APP ?? '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('WP_URL debe empezar con https://');
  if (!usuario || !clave) throw new Error('Faltan WP_USUARIO o WP_CLAVE_APP');
  const n = (env.WP_NIVEL ?? 'completo').trim().toLowerCase();
  // Un valor mal escrito cae al nivel más restrictivo, nunca al más permisivo.
  const nivel: Nivel = n === 'completo' || n === 'edicion' || n === 'lectura' ? n : 'lectura';
  return { url, usuario, clave, nivel };
}

const ORDEN: Record<Nivel, number> = { lectura: 0, edicion: 1, completo: 2 };

export function exigirNivel(cfg: Config, minimo: Nivel, accion: string): void {
  if (ORDEN[cfg.nivel] < ORDEN[minimo]) {
    throw new Error(`"${accion}" requiere nivel ${minimo}; este conector está en nivel ${cfg.nivel}.`);
  }
}

export interface Respuesta<T = unknown> {
  estado: number;
  datos: T;
  total?: number;
  paginas?: number;
}

export async function wp<T = any>(
  cfg: Config,
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  ruta: string,
  opc: { query?: Record<string, string | number | boolean | undefined>; cuerpo?: unknown } = {},
): Promise<Respuesta<T>> {
  if (!ruta.startsWith('/') || ruta.includes('..') || ruta.includes('//') || /[\s?#]/.test(ruta)) {
    throw new Error(`Ruta no válida: ${ruta}`);
  }
  const u = new URL(`${cfg.url}/wp-json${ruta}`);
  for (const [k, v] of Object.entries(opc.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  const auth = Buffer.from(`${cfg.usuario}:${cfg.clave}`).toString('base64');
  const r = await fetch(u, {
    method: metodo,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      ...(opc.cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'GI-MCP-Comunicaciones/0.1',
    },
    body: opc.cuerpo !== undefined ? JSON.stringify(opc.cuerpo) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const texto = await r.text();
  let datos: any;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto.slice(0, 500);
  }
  if (!r.ok) {
    const msg = datos && typeof datos === 'object' ? `${datos.code ?? ''} ${datos.message ?? ''}`.trim() : String(datos);
    throw new Error(`WordPress respondió ${r.status} en ${metodo} ${ruta}: ${msg}`);
  }
  const total = r.headers.get('x-wp-total');
  const paginas = r.headers.get('x-wp-totalpages');
  return { estado: r.status, datos, total: total ? Number(total) : undefined, paginas: paginas ? Number(paginas) : undefined };
}

// Registro de auditoría: va a los logs de Vercel. Nunca incluye credenciales ni contenido.
export function auditar(evento: string, detalle: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), evento, ...detalle }));
}

export function recortar(valor: unknown, max = 24_000): string {
  const s = JSON.stringify(valor, null, 1);
  return s.length > max ? s.slice(0, max) + `\n… (recortado, ${s.length - max} caracteres más; pide menos campos o una página más pequeña)` : s;
}

// --- Auditoría SEO sobre el HTML público (lo que ve Google; no depende del plugin SEO) ---

export interface AuditoriaSeo {
  url: string;
  http?: number;
  titulo?: string;
  descripcion?: string;
  canonical?: string;
  robots?: string;
  h1: number;
  imagenesSinAlt: number;
  ogTitulo: boolean;
  ogImagen: boolean;
  problemas: string[];
  error?: string;
}

const meta = (html: string, clave: string, atributo = 'name') => {
  const re = new RegExp(`<meta[^>]+${atributo}=["']${clave}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1];
};

export async function auditarUrl(url: string, hostPermitido: string): Promise<AuditoriaSeo> {
  const base: AuditoriaSeo = { url, h1: 0, imagenesSinAlt: 0, ogTitulo: false, ogImagen: false, problemas: [] };
  try {
    if (new URL(url).host !== hostPermitido) throw new Error('La URL no pertenece al sitio configurado');
    const r = await fetch(url, { headers: { 'User-Agent': 'GI-MCP-Comunicaciones/0.1 (auditoria SEO)' }, signal: AbortSignal.timeout(20_000) });
    base.http = r.status;
    const html = (await r.text()).slice(0, 600_000);
    base.titulo = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    base.descripcion = meta(html, 'description');
    base.robots = meta(html, 'robots');
    base.canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']*)["']/i)?.[1];
    base.h1 = (html.match(/<h1[\s>]/gi) ?? []).length;
    base.imagenesSinAlt = (html.match(/<img\b[^>]*>/gi) ?? []).filter((t) => !/\balt=["'][^"']+["']/i.test(t)).length;
    base.ogTitulo = !!meta(html, 'og:title', 'property');
    base.ogImagen = !!meta(html, 'og:image', 'property');
    const p = base.problemas;
    if (r.status >= 400) p.push(`HTTP ${r.status}`);
    if (!base.titulo) p.push('sin <title>');
    else if (base.titulo.length > 65) p.push(`título largo (${base.titulo.length} caracteres)`);
    else if (base.titulo.length < 20) p.push(`título corto (${base.titulo.length})`);
    if (!base.descripcion) p.push('sin meta description');
    else if (base.descripcion.length > 160) p.push(`description larga (${base.descripcion.length})`);
    else if (base.descripcion.length < 70) p.push(`description corta (${base.descripcion.length})`);
    if (base.h1 === 0) p.push('sin H1');
    if (base.h1 > 1) p.push(`${base.h1} H1`);
    if (!base.canonical) p.push('sin canonical');
    if (base.robots && /noindex/i.test(base.robots)) p.push('NOINDEX');
    if (base.imagenesSinAlt) p.push(`${base.imagenesSinAlt} imagen(es) sin alt`);
    if (!base.ogTitulo || !base.ogImagen) p.push('faltan etiquetas Open Graph (título/imagen)');
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    base.problemas.push('no se pudo auditar');
  }
  return base;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Config, auditar, auditarUrl, exigirNivel, recortar, wp } from './wp.js';

type Resultado = { content: { type: 'text'; text: string }[]; isError?: boolean };
const texto = (v: unknown): Resultado => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : recortar(v) }] });
const fallo = (e: unknown): Resultado => ({
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

// Si no viene confirmar=true, las acciones delicadas solo describen lo que harían.
const pendiente = (que: string): Resultado =>
  texto(`VISTA PREVIA (no se hizo nada). ${que}\nPara ejecutarlo, repite la llamada con confirmar=true después de que la persona lo apruebe.`);

export function crearServidor(cfg: Config): McpServer {
  const s = new McpServer({ name: 'gi-comunicaciones-wordpress', version: '0.1.0' });
  const host = new URL(cfg.url).host;

  // slug de tipo de contenido -> ruta REST (ej. gi_expertise -> /wp/v2/gi_expertise)
  let cacheTipos: Record<string, string> | undefined;
  async function rutaDe(tipo: string): Promise<string> {
    if (!cacheTipos) {
      const r = await wp<Record<string, { rest_base: string; rest_namespace?: string }>>(cfg, 'GET', '/wp/v2/types', { query: { context: 'edit' } });
      cacheTipos = {};
      for (const [slug, t] of Object.entries(r.datos)) cacheTipos[slug] = `/${t.rest_namespace ?? 'wp/v2'}/${t.rest_base}`;
    }
    const ruta = cacheTipos[tipo];
    if (!ruta) throw new Error(`Tipo "${tipo}" desconocido o sin REST. Disponibles: ${Object.keys(cacheTipos).join(', ')}`);
    return ruta;
  }
  const envolver = <A>(nombre: string, f: (a: A) => Promise<Resultado>) => async (a: A): Promise<Resultado> => {
    try {
      const r = await f(a);
      auditar('herramienta', { nombre, ok: !r.isError });
      return r;
    } catch (e) {
      auditar('herramienta', { nombre, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'error' });
      return fallo(e);
    }
  };

  // ---------- Lectura ----------
  s.registerTool('wp_sitio_info', {
    description: 'Información del sitio WordPress: nombre, URL, usuario con el que se conecta y su rol, plugin SEO detectado, nivel del conector.',
    inputSchema: {},
  }, envolver('wp_sitio_info', async () => {
    const [raiz, yo] = await Promise.all([wp<any>(cfg, 'GET', '/'), wp<any>(cfg, 'GET', '/wp/v2/users/me', { query: { context: 'edit' } })]);
    let seo: string[] = [];
    try {
      const p = await wp<any[]>(cfg, 'GET', '/wp/v2/plugins', { query: { per_page: 100 } });
      seo = p.datos.filter((x) => /yoast|rank-math|seopress|all-in-one-seo|aioseo/i.test(x.plugin) && x.status === 'active').map((x) => x.name);
    } catch { /* sin permiso para ver plugins */ }
    return texto({
      sitio: raiz.datos.name, descripcion: raiz.datos.description, url: raiz.datos.url,
      usuario: { id: yo.datos.id, nombre: yo.datos.name, roles: yo.datos.roles },
      pluginSeoActivo: seo, nivelConector: cfg.nivel,
    });
  }));

  s.registerTool('wp_tipos_contenido', {
    description: 'Lista los tipos de contenido (entradas, páginas y CPT como gi_expertise) con su slug, taxonomías y si tienen REST.',
    inputSchema: {},
  }, envolver('wp_tipos_contenido', async () => {
    const r = await wp<Record<string, any>>(cfg, 'GET', '/wp/v2/types', { query: { context: 'edit' } });
    return texto(Object.values(r.datos).map((t) => ({ slug: t.slug, nombre: t.name, rest: t.rest_base, taxonomias: t.taxonomies, jerarquico: t.hierarchical })));
  }));

  s.registerTool('wp_listar', {
    description: 'Lista contenido de un tipo (post, page o un CPT). Devuelve id, título, estado, slug, enlace y fecha de modificación.',
    inputSchema: {
      tipo: z.string().default('post'),
      buscar: z.string().optional(),
      estado: z.string().default('any').describe('publish, draft, pending, private, future, trash o any'),
      por_pagina: z.number().int().min(1).max(100).default(20),
      pagina: z.number().int().min(1).default(1),
    },
  }, envolver('wp_listar', async ({ tipo, buscar, estado, por_pagina, pagina }) => {
    const r = await wp<any[]>(cfg, 'GET', await rutaDe(tipo), {
      query: { context: 'edit', status: estado, search: buscar, per_page: por_pagina, page: pagina, orderby: 'modified', order: 'desc',
        _fields: 'id,title,status,slug,link,modified,type' },
    });
    return texto({ total: r.total, paginas: r.paginas, items: r.datos.map((x) => ({ id: x.id, titulo: x.title?.raw ?? x.title?.rendered, estado: x.status, slug: x.slug, enlace: x.link, modificado: x.modified })) });
  }));

  s.registerTool('wp_leer', {
    description: 'Lee un contenido completo (contenido, extracto, meta, campos ACF si están expuestos, taxonomías).',
    inputSchema: { tipo: z.string().default('post'), id: z.number().int() },
  }, envolver('wp_leer', async ({ tipo, id }) => {
    const r = await wp(cfg, 'GET', `${await rutaDe(tipo)}/${id}`, { query: { context: 'edit' } });
    return texto(r.datos);
  }));

  s.registerTool('wp_taxonomias', {
    description: 'Lista términos de una taxonomía (categories, tags o la de un CPT; usa wp_tipos_contenido para ver los slugs).',
    inputSchema: { taxonomia: z.string().default('categories').describe('Ruta REST: categories, tags u otra'), buscar: z.string().optional(), por_pagina: z.number().int().min(1).max(100).default(50) },
  }, envolver('wp_taxonomias', async ({ taxonomia, buscar, por_pagina }) => {
    const r = await wp<any[]>(cfg, 'GET', `/wp/v2/${taxonomia}`, { query: { search: buscar, per_page: por_pagina, _fields: 'id,name,slug,count,parent' } });
    return texto(r.datos);
  }));

  s.registerTool('wp_medios', {
    description: 'Lista la biblioteca de medios. Con solo_sin_alt=true devuelve las imágenes sin texto alternativo.',
    inputSchema: { buscar: z.string().optional(), solo_sin_alt: z.boolean().default(false), por_pagina: z.number().int().min(1).max(100).default(30), pagina: z.number().int().min(1).default(1) },
  }, envolver('wp_medios', async ({ buscar, solo_sin_alt, por_pagina, pagina }) => {
    const r = await wp<any[]>(cfg, 'GET', '/wp/v2/media', { query: { search: buscar, per_page: por_pagina, page: pagina, media_type: 'image', _fields: 'id,title,alt_text,source_url,mime_type,media_details' } });
    let items = r.datos.map((m) => ({ id: m.id, titulo: m.title?.rendered, alt: m.alt_text, url: m.source_url, peso_kb: m.media_details?.filesize ? Math.round(m.media_details.filesize / 1024) : undefined }));
    if (solo_sin_alt) items = items.filter((m) => !m.alt);
    return texto({ total: r.total, paginas: r.paginas, items });
  }));

  // ---------- SEO ----------
  s.registerTool('wp_seo_url', {
    description: 'Audita el SEO básico de una URL del sitio leyendo su HTML público: title, description, H1, canonical, robots/noindex, alt de imágenes, Open Graph.',
    inputSchema: { url: z.string().url() },
  }, envolver('wp_seo_url', async ({ url }) => texto(await auditarUrl(url, host))));

  s.registerTool('wp_seo_estado', {
    description: 'Estado SEO de varios contenidos publicados de un tipo (audita su HTML público). Resume cuántos tienen problemas y cuáles.',
    inputSchema: { tipo: z.string().default('page'), limite: z.number().int().min(1).max(40).default(20), pagina: z.number().int().min(1).default(1) },
  }, envolver('wp_seo_estado', async ({ tipo, limite, pagina }) => {
    const r = await wp<any[]>(cfg, 'GET', await rutaDe(tipo), { query: { status: 'publish', per_page: limite, page: pagina, _fields: 'id,title,link' } });
    const filas: any[] = [];
    for (let i = 0; i < r.datos.length; i += 5) {
      const lote = await Promise.all(r.datos.slice(i, i + 5).map(async (x) => ({ id: x.id, titulo: x.title?.rendered, ...(await auditarUrl(x.link, host)) })));
      filas.push(...lote);
    }
    const conProblemas = filas.filter((f) => f.problemas.length);
    return texto({ revisados: filas.length, totalPublicados: r.total, conProblemas: conProblemas.length,
      detalle: conProblemas.map((f) => ({ id: f.id, titulo: f.titulo, url: f.url, problemas: f.problemas })) });
  }));

  // ---------- Edición ----------
  s.registerTool('wp_crear', {
    description: 'Crea contenido de cualquier tipo (post, page, CPT). Por defecto queda como BORRADOR. campos acepta title, content, excerpt, slug, meta, acf, categories, featured_media, etc.',
    inputSchema: { tipo: z.string().default('post'), campos: z.record(z.any()) },
  }, envolver('wp_crear', async ({ tipo, campos }) => {
    exigirNivel(cfg, 'edicion', 'crear contenido');
    const r = await wp<any>(cfg, 'POST', await rutaDe(tipo), { cuerpo: { status: 'draft', ...campos } });
    auditar('crear', { tipo, id: r.datos.id, estado: r.datos.status });
    return texto({ id: r.datos.id, estado: r.datos.status, enlace: r.datos.link });
  }));

  s.registerTool('wp_actualizar', {
    description: 'Edita cualquier campo de un contenido (título, contenido, slug, meta, acf, taxonomías, estado). Publicar (status=publish) o programar exige confirmar=true.',
    inputSchema: { tipo: z.string().default('post'), id: z.number().int(), campos: z.record(z.any()), confirmar: z.boolean().default(false) },
  }, envolver('wp_actualizar', async ({ tipo, id, campos, confirmar }) => {
    exigirNivel(cfg, 'edicion', 'editar contenido');
    const publica = campos.status === 'publish' || campos.status === 'future';
    if (publica && !confirmar) return pendiente(`Cambiaría el contenido ${tipo} #${id} a estado "${campos.status}" (visible al público en producción).`);
    const r = await wp<any>(cfg, 'POST', `${await rutaDe(tipo)}/${id}`, { cuerpo: campos });
    auditar('actualizar', { tipo, id, campos: Object.keys(campos) });
    return texto({ id: r.datos.id, estado: r.datos.status, modificado: r.datos.modified, enlace: r.datos.link });
  }));

  s.registerTool('wp_actualizar_varios', {
    description: 'Aplica el mismo cambio a varios contenidos de un tipo (hasta 50). Siempre muestra primero una vista previa; exige confirmar=true.',
    inputSchema: { tipo: z.string(), ids: z.array(z.number().int()).min(1).max(50), campos: z.record(z.any()), confirmar: z.boolean().default(false) },
  }, envolver('wp_actualizar_varios', async ({ tipo, ids, campos, confirmar }) => {
    exigirNivel(cfg, 'edicion', 'edición masiva');
    if (!confirmar) return pendiente(`Aplicaría ${JSON.stringify(Object.keys(campos))} a ${ids.length} contenidos de tipo ${tipo}: ${ids.join(', ')}.`);
    const ruta = await rutaDe(tipo);
    const res: any[] = [];
    for (const id of ids) {
      try { await wp(cfg, 'POST', `${ruta}/${id}`, { cuerpo: campos }); res.push({ id, ok: true }); }
      catch (e) { res.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    auditar('actualizar_varios', { tipo, ids: ids.length, campos: Object.keys(campos) });
    return texto(res);
  }));

  s.registerTool('wp_crear_termino', {
    description: 'Crea un término en una taxonomía (categoría, etiqueta o taxonomía de un CPT).',
    inputSchema: { taxonomia: z.string().default('categories'), nombre: z.string(), slug: z.string().optional(), padre: z.number().int().optional() },
  }, envolver('wp_crear_termino', async ({ taxonomia, nombre, slug, padre }) => {
    exigirNivel(cfg, 'edicion', 'crear términos');
    const r = await wp<any>(cfg, 'POST', `/wp/v2/${taxonomia}`, { cuerpo: { name: nombre, slug, parent: padre } });
    return texto({ id: r.datos.id, nombre: r.datos.name, slug: r.datos.slug });
  }));

  s.registerTool('wp_medio_actualizar', {
    description: 'Actualiza título, texto alternativo, leyenda o descripción de un archivo de la biblioteca de medios.',
    inputSchema: { id: z.number().int(), alt_text: z.string().optional(), title: z.string().optional(), caption: z.string().optional(), description: z.string().optional() },
  }, envolver('wp_medio_actualizar', async ({ id, ...campos }) => {
    exigirNivel(cfg, 'edicion', 'editar medios');
    const r = await wp<any>(cfg, 'POST', `/wp/v2/media/${id}`, { cuerpo: campos });
    return texto({ id: r.datos.id, alt: r.datos.alt_text });
  }));

  // ---------- Borrado ----------
  s.registerTool('wp_papelera', {
    description: 'Envía un contenido a la papelera (recuperable). Exige confirmar=true.',
    inputSchema: { tipo: z.string().default('post'), id: z.number().int(), confirmar: z.boolean().default(false) },
  }, envolver('wp_papelera', async ({ tipo, id, confirmar }) => {
    exigirNivel(cfg, 'completo', 'mover a la papelera');
    if (!confirmar) return pendiente(`Enviaría a la papelera ${tipo} #${id}.`);
    const r = await wp<any>(cfg, 'DELETE', `${await rutaDe(tipo)}/${id}`);
    auditar('papelera', { tipo, id });
    return texto({ id, estado: r.datos.status ?? 'trash' });
  }));

  s.registerTool('wp_eliminar_definitivo', {
    description: 'Elimina un contenido PARA SIEMPRE (sin papelera, irreversible). Exige confirmar=true.',
    inputSchema: { tipo: z.string().default('post'), id: z.number().int(), confirmar: z.boolean().default(false) },
  }, envolver('wp_eliminar_definitivo', async ({ tipo, id, confirmar }) => {
    exigirNivel(cfg, 'completo', 'eliminar definitivamente');
    if (!confirmar) return pendiente(`Eliminaría DEFINITIVAMENTE ${tipo} #${id}. No se puede deshacer.`);
    await wp(cfg, 'DELETE', `${await rutaDe(tipo)}/${id}`, { query: { force: true } });
    auditar('eliminar_definitivo', { tipo, id });
    return texto({ id, eliminado: true });
  }));

  // ---------- Plugins ----------
  s.registerTool('wp_plugins', {
    description: 'Lista los plugins instalados con su estado (active/inactive) y versión.',
    inputSchema: { estado: z.enum(['active', 'inactive', 'all']).default('all') },
  }, envolver('wp_plugins', async ({ estado }) => {
    const r = await wp<any[]>(cfg, 'GET', '/wp/v2/plugins', { query: { per_page: 100, status: estado === 'all' ? undefined : estado } });
    return texto(r.datos.map((p) => ({ plugin: p.plugin, nombre: p.name, estado: p.status, version: p.version })));
  }));

  s.registerTool('wp_plugin_estado', {
    description: 'Activa o desactiva un plugin (ej. "wordpress-seo/wp-seo"). Cambia el sitio en producción: exige confirmar=true.',
    inputSchema: { plugin: z.string().describe('Valor "plugin" que devuelve wp_plugins'), estado: z.enum(['active', 'inactive']), confirmar: z.boolean().default(false) },
  }, envolver('wp_plugin_estado', async ({ plugin, estado, confirmar }) => {
    exigirNivel(cfg, 'completo', 'cambiar plugins');
    if (plugin.includes('..') || !/^[\w.\-]+(\/[\w.\-]+)?$/.test(plugin)) throw new Error('Nombre de plugin no válido');
    if (!confirmar) return pendiente(`Pondría el plugin "${plugin}" en estado ${estado} en el sitio de producción.`);
    const r = await wp<any>(cfg, 'POST', `/wp/v2/plugins/${plugin}`, { cuerpo: { status: estado } });
    auditar('plugin_estado', { plugin, estado });
    return texto({ plugin: r.datos.plugin, estado: r.datos.status });
  }));

  // ---------- Limpieza ----------
  s.registerTool('wp_limpieza_diagnostico', {
    description: 'Cuenta lo que se puede limpiar: borradores, papelera y auto-borradores por tipo, y comentarios spam o en papelera.',
    inputSchema: { tipos: z.array(z.string()).default(['post', 'page']) },
  }, envolver('wp_limpieza_diagnostico', async ({ tipos }) => {
    const salida: Record<string, unknown> = {};
    for (const t of tipos) {
      const ruta = await rutaDe(t);
      const c: Record<string, number | undefined> = {};
      for (const e of ['draft', 'trash', 'auto-draft', 'pending']) {
        try { c[e] = (await wp(cfg, 'GET', ruta, { query: { status: e, per_page: 1, _fields: 'id' } })).total; } catch { c[e] = undefined; }
      }
      salida[t] = c;
    }
    const com: Record<string, number | undefined> = {};
    for (const e of ['spam', 'trash']) {
      try { com[e] = (await wp(cfg, 'GET', '/wp/v2/comments', { query: { status: e, per_page: 1, _fields: 'id' } })).total; } catch { com[e] = undefined; }
    }
    return texto({ contenido: salida, comentarios: com });
  }));

  s.registerTool('wp_limpieza_ejecutar', {
    description: 'Ejecuta una limpieza: "papelera" (vacía la papelera de un tipo), "spam" (borra comentarios spam) o "revisiones" (borra revisiones antiguas conservando las N más recientes). Procesa hasta 50 elementos por llamada. Sin confirmar=true solo muestra qué se borraría.',
    inputSchema: {
      accion: z.enum(['papelera', 'spam', 'revisiones']),
      tipo: z.string().default('post').describe('Tipo de contenido (papelera y revisiones)'),
      conservar: z.number().int().min(0).max(20).default(3).describe('Revisiones a conservar por contenido'),
      confirmar: z.boolean().default(false),
    },
  }, envolver('wp_limpieza_ejecutar', async ({ accion, tipo, conservar, confirmar }) => {
    exigirNivel(cfg, 'completo', 'limpieza');
    let objetivos: { ruta: string; id: number }[] = [];
    if (accion === 'papelera') {
      const ruta = await rutaDe(tipo);
      const r = await wp<any[]>(cfg, 'GET', ruta, { query: { status: 'trash', per_page: 50, _fields: 'id' } });
      objetivos = r.datos.map((x) => ({ ruta, id: x.id }));
    } else if (accion === 'spam') {
      const r = await wp<any[]>(cfg, 'GET', '/wp/v2/comments', { query: { status: 'spam', per_page: 50, _fields: 'id' } });
      objetivos = r.datos.map((x) => ({ ruta: '/wp/v2/comments', id: x.id }));
    } else {
      const ruta = await rutaDe(tipo);
      const items = await wp<any[]>(cfg, 'GET', ruta, { query: { status: 'any', per_page: 10, orderby: 'modified', _fields: 'id' } });
      for (const it of items.datos) {
        try {
          const rev = await wp<any[]>(cfg, 'GET', `${ruta}/${it.id}/revisions`, { query: { per_page: 100, orderby: 'date', order: 'desc', _fields: 'id' } });
          for (const v of rev.datos.slice(conservar)) objetivos.push({ ruta: `${ruta}/${it.id}/revisions`, id: v.id });
        } catch { /* tipo sin revisiones */ }
      }
      objetivos = objetivos.slice(0, 50);
    }
    if (!confirmar) return pendiente(`"${accion}" borraría ${objetivos.length} elemento(s) de forma definitiva${accion === 'revisiones' ? ` (conservando ${conservar} revisiones por contenido, sobre los 10 contenidos modificados más recientemente)` : ''}.`);
    let borrados = 0; const errores: string[] = [];
    for (const o of objetivos) {
      try { await wp(cfg, 'DELETE', `${o.ruta}/${o.id}`, { query: { force: true } }); borrados++; }
      catch (e) { errores.push(`#${o.id}: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`); }
    }
    auditar('limpieza', { accion, tipo, borrados, errores: errores.length });
    return texto({ borrados, errores, nota: borrados === 50 ? 'Puede haber más: vuelve a ejecutar.' : undefined });
  }));

  // ---------- Escape para casos no cubiertos ----------
  s.registerTool('wp_rest', {
    description: 'Llamada directa a la REST API de WordPress (rutas /wp/v2/..., /yoast/v1/..., /acf/v3/..., etc.) para lo que no cubren las otras herramientas. GET libre; POST/PUT/PATCH exigen nivel edicion; DELETE exige nivel completo y confirmar=true.',
    inputSchema: {
      metodo: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      ruta: z.string().describe('Empieza con /, ej. /wp/v2/settings'),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      cuerpo: z.any().optional(),
      confirmar: z.boolean().default(false),
    },
  }, envolver('wp_rest', async ({ metodo, ruta, query, cuerpo, confirmar }) => {
    if (metodo === 'GET') { /* libre */ }
    else if (metodo === 'DELETE') {
      exigirNivel(cfg, 'completo', 'DELETE');
      if (!confirmar) return pendiente(`Haría DELETE ${ruta}.`);
    } else {
      exigirNivel(cfg, 'edicion', metodo);
      if (/^\/wp\/v2\/(settings|users|plugins|themes)/.test(ruta)) {
        exigirNivel(cfg, 'completo', `${metodo} ${ruta}`);
        if (!confirmar) return pendiente(`Haría ${metodo} ${ruta}: es una zona sensible (ajustes, usuarios, plugins o temas).`);
      }
    }
    const r = await wp(cfg, metodo, ruta, { query, cuerpo });
    auditar('rest', { metodo, ruta });
    return texto({ estado: r.estado, total: r.total, datos: r.datos });
  }));

  return s;
}

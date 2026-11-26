# MCP Comunicaciones · Green Initiative

Conector MCP que permite a los Claude de Green Initiative trabajar sobre el WordPress de Comunicaciones (greeninitiative.eco): editar entradas, páginas y CPT (p. ej. `gi_expertise`), medios, taxonomías, plugins, limpieza y estado SEO.

## Seguridad (es producción)
- **Nivel** (`WP_NIVEL`): `lectura` (solo leer), `edicion` (crear/editar), `completo` (además borrar, plugins y limpieza). Un valor mal escrito cae a `lectura`.
- Lo delicado **no se ejecuta sin `confirmar=true`**: publicar, programar, papelera, borrado definitivo, activar/desactivar plugins, limpieza, edición masiva, ajustes/usuarios/temas vía `wp_rest`. Sin confirmar, la herramienta solo describe lo que haría.
- Crear contenido lo deja como **borrador**.
- La clave del conector va en la dirección (`/mcp/<MCP_CLAVE>`), se compara en tiempo constante y se exige un mínimo de 24 caracteres. Trátala como contraseña: quien tenga la dirección puede usar el conector.
- Las credenciales de WordPress solo viven en variables de entorno de Vercel. Nunca en el repo.
- Cada acción de escritura deja una línea en los logs de Vercel (sin contenido ni credenciales).
- `wp_seo_url` solo audita URLs del propio dominio.

## Herramientas
Lectura: `wp_sitio_info`, `wp_tipos_contenido`, `wp_listar`, `wp_leer`, `wp_taxonomias`, `wp_medios`, `wp_plugins`, `wp_limpieza_diagnostico`.
SEO: `wp_seo_url`, `wp_seo_estado` (audita el HTML público: title, description, H1, canonical, noindex, alt, Open Graph).
Edición: `wp_crear`, `wp_actualizar`, `wp_actualizar_varios`, `wp_crear_termino`, `wp_medio_actualizar`.
Delicadas: `wp_papelera`, `wp_eliminar_definitivo`, `wp_plugin_estado`, `wp_limpieza_ejecutar`, `wp_rest`.

## Puesta en marcha
1. En WordPress, crea un usuario dedicado (p. ej. `mcp-comunicaciones`) con rol Administrador y genera una **contraseña de aplicación** (Usuarios → Perfil → Contraseñas de aplicación).
2. En Vercel: importa este repo y define las variables de `.env.example` (`WP_URL`, `WP_USUARIO`, `WP_CLAVE_APP`, `MCP_CLAVE`, `WP_NIVEL`). Genera `MCP_CLAVE` con: `openssl rand -hex 24`.
3. Despliega. La dirección del conector será `https://<tu-proyecto>.vercel.app/mcp/<MCP_CLAVE>`.
4. En Claude: Configuración → Conectores → Añadir conector personalizado, y pega esa dirección (un propietario de la organización puede añadirlo para todo el equipo).

## Desarrollo
```
npm install
npm run typecheck
npm run probar     # WordPress simulado + cliente MCP real
```

## Otras áreas
Para otra área, copia este repo (p. ej. `MCP-Comercial-...`), cambia las herramientas de `src/servidor.ts` y despliega con sus propias variables. Cada área queda como conector independiente.

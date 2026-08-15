const { createClient } = require('@supabase/supabase-js');
const RESERVED_SLUGS = require('../lib/reservedSlugs');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 404 real (no 200 con mensaje de error) para que Google no indexe esto
// como contenido válido, y el mismo resultado tanto si el slug nunca
// existió como si la empresa desactivó su página — no hay forma de
// distinguir un caso del otro desde afuera.
function paginaNoDisponible(res) {
  res.status(404);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Página no disponible — Werkr</title>
<meta name="robots" content="noindex">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f0f4f8; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    background: #fff; border-radius: 16px; padding: 40px 24px;
    max-width: 420px; width: 100%; text-align: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }
  .logo-icon {
    width: 48px; height: 48px; background: #0066cc; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 26px; font-weight: 900; margin: 0 auto 20px;
  }
  h1 { font-size: 18px; color: #1a1a2e; margin-bottom: 8px; }
  p { font-size: 14px; color: #888; margin-bottom: 24px; }
  a { display: inline-block; background: #0066cc; color: #fff; text-decoration: none;
      padding: 12px 24px; border-radius: 10px; font-weight: 700; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo-icon">W</div>
    <h1>Esta página no está disponible</h1>
    <p>El perfil que buscás no existe o fue desactivado por su dueño.</p>
    <a href="https://werkrweb.com.ar">Ir a werkrweb.com.ar</a>
  </div>
</body>
</html>`);
}

module.exports = async function handler(req, res) {
  const slug = String(req.query.slug || '').toLowerCase().trim();

  // Paso 1, antes de tocar Supabase: slug vacío o reservado → corta acá.
  if (!slug || RESERVED_SLUGS.has(slug)) {
    return paginaNoDisponible(res);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Select explícito y mínimo — nunca '*'. Ninguna columna fiscal/interna
  // (afip_cert, afip_key, afip_cuit, dictamen_habilitado, etc.) puede
  // aparecer acá: este endpoint es público y usa la service role key.
  const { data: empresa, error: empresaError } = await supabase
    .from('empresas')
    .select('id, nombre, slug, especialidad, zona_cobertura, foto_url, bio, telefono_publico, perfil_publico_activo')
    .eq('slug', slug)
    .eq('perfil_publico_activo', true)
    .maybeSingle();

  if (empresaError || !empresa) {
    return paginaNoDisponible(res);
  }

  const { data: resenasData } = await supabase
    .from('resenas')
    .select('cliente_nombre, puntaje, comentario, created_at')
    .eq('empresa_id', empresa.id)
    .eq('completada', true)
    .order('created_at', { ascending: false });

  const resenas = resenasData || [];
  const promedio = resenas.length
    ? (resenas.reduce((acc, r) => acc + r.puntaje, 0) / resenas.length).toFixed(1)
    : null;

  const nombre = escapeHtml(empresa.nombre);
  const especialidades = (empresa.especialidad || []).map(escapeHtml);
  const descripcion = escapeHtml(empresa.bio || `Perfil de ${empresa.nombre} en Werkr`);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${nombre} — Werkr</title>
<meta name="description" content="${descripcion}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${nombre}">
<meta property="og:description" content="${descripcion}">
${empresa.foto_url ? `<meta property="og:image" content="${escapeHtml(empresa.foto_url)}">` : ''}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f0f4f8; min-height: 100vh; padding: 20px;
    display: flex; justify-content: center;
  }
  .card {
    background: #fff; border-radius: 16px; padding: 32px 24px;
    max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }
  .foto {
    width: 88px; height: 88px; border-radius: 50%; object-fit: cover;
    display: block; margin: 0 auto 16px;
  }
  .logo-icon {
    width: 88px; height: 88px; background: #0066cc; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 40px; font-weight: 900; margin: 0 auto 16px;
  }
  h1 { font-size: 22px; color: #1a1a2e; text-align: center; margin-bottom: 8px; }
  .especialidades {
    display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 12px;
  }
  .tag {
    background: #eaf2ff; color: #0066cc; font-size: 12px; font-weight: 700;
    padding: 5px 10px; border-radius: 20px;
  }
  .zona { text-align: center; color: #666; font-size: 13px; margin-bottom: 16px; }
  .bio { text-align: center; color: #444; font-size: 14px; line-height: 1.5; margin-bottom: 20px; }
  .rating {
    text-align: center; font-size: 15px; font-weight: 700; color: #1a1a2e;
    margin-bottom: 24px;
  }
  .btn-whatsapp {
    display: block; text-align: center; background: #25d366; color: #fff;
    text-decoration: none; padding: 14px; border-radius: 12px; font-weight: 700;
    font-size: 15px; margin-bottom: 24px;
  }
  .resenas { border-top: 1px solid #eee; padding-top: 16px; }
  .resena { padding: 12px 0; border-bottom: 1px solid #f2f2f2; }
  .resena:last-child { border-bottom: none; }
  .resena-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .resena-nombre { font-size: 13px; font-weight: 700; color: #1a1a2e; }
  .resena-estrellas { color: #ffb400; font-size: 13px; }
  .resena-comentario { font-size: 13px; color: #666; }
  .sin-resenas { text-align: center; color: #999; font-size: 13px; padding: 12px 0; }
  .form-solicitud { border-top: 1px solid #eee; padding-top: 20px; margin-top: 24px; }
  .form-solicitud h2 { font-size: 16px; color: #1a1a2e; margin-bottom: 4px; }
  .form-solicitud .sub { color: #888; font-size: 13px; margin-bottom: 16px; }
  .form-solicitud label { display: block; font-size: 13px; color: #666; margin-bottom: 6px; margin-top: 14px; }
  .form-solicitud input[type="text"],
  .form-solicitud input[type="tel"],
  .form-solicitud textarea {
    width: 100%; border: 1px solid #ddd; border-radius: 10px;
    padding: 12px; font-size: 15px; background: #fafafa; font-family: inherit;
  }
  .form-solicitud textarea { min-height: 90px; resize: vertical; }
  .btn-solicitud {
    width: 100%; padding: 14px; border-radius: 12px; border: none;
    font-size: 15px; font-weight: 700; cursor: pointer; margin-top: 20px;
    background: #0066cc; color: #fff;
  }
  .btn-solicitud:disabled { opacity: 0.5; cursor: not-allowed; }
  .form-mensaje { font-size: 13px; margin-top: 12px; text-align: center; }
  .form-mensaje.error { color: #ff3b30; }
  .form-mensaje.ok { color: #1a8a3d; font-size: 14px; font-weight: 600; padding: 8px 0; }
</style>
</head>
<body>
<div class="card">
  ${empresa.foto_url
    ? `<img class="foto" src="${escapeHtml(empresa.foto_url)}" alt="${nombre}">`
    : `<div class="logo-icon">${nombre.charAt(0).toUpperCase()}</div>`}
  <h1>${nombre}</h1>
  ${especialidades.length ? `<div class="especialidades">${especialidades.map((e) => `<span class="tag">${e}</span>`).join('')}</div>` : ''}
  ${empresa.zona_cobertura ? `<div class="zona">📍 ${escapeHtml(empresa.zona_cobertura)}</div>` : ''}
  ${empresa.bio ? `<p class="bio">${escapeHtml(empresa.bio)}</p>` : ''}
  ${promedio ? `<div class="rating">⭐ ${promedio} · ${resenas.length} reseña${resenas.length === 1 ? '' : 's'}</div>` : ''}
  ${empresa.telefono_publico ? `<a class="btn-whatsapp" href="https://wa.me/54${escapeHtml(empresa.telefono_publico).replace(/\D/g, '')}">💬 Contactar por WhatsApp</a>` : ''}
  <div class="resenas">
    ${resenas.length ? resenas.map((r) => `
      <div class="resena">
        <div class="resena-header">
          <span class="resena-nombre">${escapeHtml(r.cliente_nombre || 'Cliente')}</span>
          <span class="resena-estrellas">${'★'.repeat(r.puntaje)}${'☆'.repeat(5 - r.puntaje)}</span>
        </div>
        ${r.comentario ? `<p class="resena-comentario">${escapeHtml(r.comentario)}</p>` : ''}
      </div>
    `).join('') : '<div class="sin-resenas">Todavía no hay reseñas.</div>'}
  </div>
  <form class="form-solicitud" id="form-solicitud">
    <input type="hidden" name="slug" value="${escapeHtml(slug)}">
    <h2>Pedí un presupuesto</h2>
    <div class="sub">Contanos qué necesitás y te contactamos.</div>
    <label>Nombre</label>
    <input type="text" name="nombre" required maxlength="100" placeholder="Tu nombre">
    <label>Teléfono</label>
    <input type="tel" name="telefono" required maxlength="30" placeholder="Tu teléfono">
    <label>Dirección (opcional)</label>
    <input type="text" name="direccion" maxlength="200" placeholder="Dirección">
    <label>Contanos el trabajo</label>
    <textarea name="descripcion_trabajo" required minlength="15" placeholder="Describí brevemente qué necesitás (mínimo 15 caracteres)"></textarea>
    <button type="submit" class="btn-solicitud" id="btn-solicitud">Enviar solicitud</button>
    <p class="form-mensaje" id="form-mensaje" hidden></p>
  </form>
</div>
<script>
  document.getElementById('form-solicitud').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = e.target;
    var btn = document.getElementById('btn-solicitud');
    var mensaje = document.getElementById('form-mensaje');
    mensaje.hidden = true;

    var body = {
      slug: form.slug.value,
      nombre: form.nombre.value.trim(),
      telefono: form.telefono.value.trim(),
      direccion: form.direccion.value.trim(),
      descripcion_trabajo: form.descripcion_trabajo.value.trim(),
    };

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      var res = await fetch('/api/solicitud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        mensaje.textContent = data.error || 'No se pudo enviar. Intentá de nuevo.';
        mensaje.className = 'form-mensaje error';
        mensaje.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Enviar solicitud';
        return;
      }

      form.innerHTML = '<p class="form-mensaje ok">¡Listo! Te vamos a contactar a la brevedad.</p>';
    } catch (err) {
      mensaje.textContent = 'No se pudo enviar. Intentá de nuevo.';
      mensaje.className = 'form-mensaje error';
      mensaje.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Enviar solicitud';
    }
  });
</script>
</body>
</html>`;

  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
};

// Única fuente de verdad de slugs prohibidos para páginas públicas de empresa.
// api/tecnico/[slug].js la consulta en runtime antes de resolver cualquier
// slug — vercel.json no puede importar esto (es config estática), así que
// esta lista es la autoridad real; el catch-all de vercel.json es solo un
// fallback amplio, no el filtro de seguridad.
module.exports = new Set([
  // colisionan con rutas reales de este proyecto
  'api', 'resena', 'presupuesto', 'privacidad', 'favicon.ico', 'robots.txt',
  // ambiguos, no profesionales, o variantes del dominio/marca propia
  'www', 'admin', 'index', 'tecnico', 'tecnicos', 'werkr', 'werkrweb',
  'help', 'soporte', 'null', 'undefined',
]);

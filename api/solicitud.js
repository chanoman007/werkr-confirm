const { createClient } = require('@supabase/supabase-js');

const MIN_DESCRIPCION = 15;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { slug, nombre, telefono, direccion, descripcion_trabajo } = req.body || {};

  const slugLimpio = String(slug || '').toLowerCase().trim();
  const nombreLimpio = String(nombre || '').trim();
  const telefonoLimpio = String(telefono || '').trim();
  const direccionLimpia = String(direccion || '').trim() || null;
  const descripcionLimpia = String(descripcion_trabajo || '').trim();

  if (!slugLimpio) return res.status(400).json({ error: 'Falta slug' });
  if (!nombreLimpio) return res.status(400).json({ error: 'Falta nombre' });
  if (!telefonoLimpio) return res.status(400).json({ error: 'Falta teléfono' });
  if (descripcionLimpia.length < MIN_DESCRIPCION) {
    return res.status(400).json({
      error: `Contanos un poco más del trabajo (mínimo ${MIN_DESCRIPCION} caracteres)`,
    });
  }

  // Mismo gate que api/tecnico.js: solo empresas con perfil público
  // activo pueden recibir solicitudes por este canal. El slug ya es
  // público (viene del hidden input, que viene de la URL); el
  // empresa_id se resuelve acá, nunca se confía en un empresa_id
  // que mande el cliente directamente.
  const { data: empresa, error: empresaError } = await supabase
    .from('empresas')
    .select('id')
    .eq('slug', slugLimpio)
    .eq('perfil_publico_activo', true)
    .maybeSingle();

  if (empresaError || !empresa) {
    return res.status(404).json({ error: 'Empresa no encontrada' });
  }

  const { error: insertError } = await supabase
    .from('solicitudes_web')
    .insert({
      empresa_id: empresa.id,
      nombre: nombreLimpio,
      telefono: telefonoLimpio,
      direccion: direccionLimpia,
      descripcion_trabajo: descripcionLimpia,
    });

  if (insertError) {
    return res.status(500).json({ error: 'No se pudo enviar la solicitud' });
  }

  return res.status(201).json({ ok: true });
};

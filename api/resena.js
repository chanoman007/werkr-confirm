const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  if (req.method === 'GET') {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Falta token' });

    const { data, error } = await supabase
      .from('resenas')
      .select('cliente_nombre, puntaje, comentario, completada')
      .eq('token', token)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Reseña no encontrada' });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { token, cliente_nombre, puntaje, comentario } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Falta token' });
    const puntajeNum = Number(puntaje);
    if (!Number.isInteger(puntajeNum) || puntajeNum < 1 || puntajeNum > 5) {
      return res.status(400).json({ error: 'Puntaje inválido' });
    }

    // UPDATE condicionado a completada=false: si el token ya fue usado (doble
    // submit, o dos requests concurrentes con el mismo token) esta query no
    // afecta ninguna fila, en vez de pisar la reseña ya guardada.
    const { data: updated, error: updateError } = await supabase
      .from('resenas')
      .update({
        cliente_nombre: (cliente_nombre || '').trim() || null,
        puntaje: puntajeNum,
        comentario: (comentario || '').trim() || null,
        completada: true,
      })
      .eq('token', token)
      .eq('completada', false)
      .select()
      .maybeSingle();

    if (updateError) return res.status(500).json({ error: 'No se pudo guardar la reseña' });

    if (!updated) {
      const { data: existing } = await supabase
        .from('resenas')
        .select('id')
        .eq('token', token)
        .maybeSingle();
      if (!existing) return res.status(404).json({ error: 'Reseña no encontrada' });
      return res.status(409).json({ error: 'Esta reseña ya fue enviada' });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};

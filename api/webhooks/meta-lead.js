const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Tabla esperada en Supabase (crearla manualmente si no existe):
//
// create table leads_meta (
//   id uuid primary key default gen_random_uuid(),
//   lead_id text unique not null,
//   nombre text,
//   telefono text not null,
//   rubro text,
//   cantidad_tecnicos text,
//   m1_enviado boolean default false,
//   m1_enviado_at timestamptz,
//   m1_error text,
//   raw_payload jsonb,
//   created_at timestamptz default now()
// );

const GRAPH_API_VERSION = 'v21.0';

// Meta no incluye el bodyParser de Vercel porque necesitamos el body
// crudo para validar la firma X-Hub-Signature-256.
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleVerification(req, res);
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  if (process.env.META_APP_SECRET) {
    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(rawBody, signature, process.env.META_APP_SECRET)) {
      return res.status(401).json({ error: 'Firma invalida' });
    }
  }

  let body;
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch {
    return res.status(400).json({ error: 'JSON invalido' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let leads;
  try {
    leads = await collectLeads(body);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const results = [];
  for (const lead of leads) {
    results.push(await processLead(supabase, lead));
  }

  return res.status(200).json({ ok: true, results });
};

module.exports.config = { api: { bodyParser: false } };

function handleVerification(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && process.env.META_VERIFY_TOKEN && token === process.env.META_VERIFY_TOKEN) {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(challenge);
  }
  return res.status(403).end();
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// Soporta dos formatos de entrada:
// 1) El payload real de Meta Lead Ads: { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id } }] }] }
//    En este caso solo vienen los IDs; hay que pedirle los datos del lead a la Graph API.
// 2) Un payload directo/simplificado { nombre, telefono, rubro, urgencia|cantidad_tecnicos, lead_id }
//    util para pruebas manuales o si hay algo (Zapier/Make) normalizando antes de pegarle a este endpoint.
async function collectLeads(body) {
  if (Array.isArray(body.entry)) {
    const leads = [];
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen' || !change.value?.leadgen_id) continue;
        const details = await fetchLeadDetails(change.value.leadgen_id);
        leads.push(leadFromGraphData(details));
      }
    }
    return leads;
  }

  return [leadFromDirectPayload(body)];
}

async function fetchLeadDetails(leadgenId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'Error obteniendo datos del lead desde Meta');
  return data;
}

function fieldValue(fieldData, aliases) {
  if (!Array.isArray(fieldData)) return null;
  const found = fieldData.find((f) => aliases.includes(String(f.name).toLowerCase()));
  return found?.values?.[0] ?? null;
}

function leadFromGraphData(data) {
  const fd = data.field_data;
  return {
    leadId: data.id,
    nombre: fieldValue(fd, ['full_name', 'nombre', 'name']),
    telefono: fieldValue(fd, ['phone_number', 'telefono', 'teléfono', 'phone']),
    rubro: fieldValue(fd, ['rubro', 'industry', 'industria']),
    cantidadTecnicos: fieldValue(fd, [
      'cantidad_tecnicos',
      'cantidad_técnicos',
      'urgencia',
      'tecnicos',
      'técnicos',
      'technicians',
    ]),
    raw: data,
  };
}

function leadFromDirectPayload(body) {
  const nombre = body.nombre ?? null;
  const telefono = body.telefono ?? body.phone ?? null;
  const rubro = body.rubro ?? null;
  const cantidadTecnicos = body.cantidad_tecnicos ?? body.urgencia ?? null;
  return {
    leadId: body.lead_id || telefono,
    nombre,
    telefono,
    rubro,
    cantidadTecnicos,
    raw: body,
  };
}

// Numeros de Meta Lead Ads suelen venir con codigo de pais; esto es una
// normalizacion minima. Para moviles de Argentina, WhatsApp Business API
// puede requerir el "9" despues del 54 (formato 549...) segun el numero:
// si los envios fallan por formato, ajustar aca.
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (!digits.startsWith('54')) digits = '54' + digits.replace(/^0/, '');
  return digits;
}

function buildM1Text({ nombre, rubro, cantidadTecnicos }) {
  return `Hola ${nombre || ''}, sos ${rubro || 'técnico'} con ${cantidadTecnicos || 'tu equipo'}. Técnicos como vos usan Werkr para dejar de perder datos en audios y WhatsApp. En 3 semanas pasan de caos a tener todo centralizado. ¿Los técnicos tienen Android? Te armo la demo en 10 minutos sin compromiso.`;
}

async function sendWhatsAppMessage(phone, { nombre, rubro, cantidadTecnicos }) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;

  const payload = templateName
    ? {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: nombre || 'técnico' },
                { type: 'text', text: rubro || 'tu rubro' },
                { type: 'text', text: cantidadTecnicos || 'tu equipo' },
              ],
            },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: buildM1Text({ nombre, rubro, cantidadTecnicos }), preview_url: false },
      };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    return { ok: false, error: data?.error?.message || 'Error enviando WhatsApp' };
  }
  return { ok: true, messageId: data?.messages?.[0]?.id };
}

async function processLead(supabase, lead) {
  const telefono = normalizePhone(lead.telefono);
  if (!lead.leadId || !telefono) {
    return { leadId: lead.leadId || null, ok: false, error: 'Falta lead_id o telefono' };
  }

  const { data: existing, error: selectError } = await supabase
    .from('leads_meta')
    .select('id')
    .eq('lead_id', lead.leadId)
    .maybeSingle();

  if (selectError) {
    return { leadId: lead.leadId, ok: false, error: 'Error consultando Supabase: ' + selectError.message };
  }
  if (existing) {
    return { leadId: lead.leadId, skipped: true, reason: 'ya existe' };
  }

  const sendResult = await sendWhatsAppMessage(telefono, lead);

  const { error: insertError } = await supabase.from('leads_meta').insert({
    lead_id: lead.leadId,
    nombre: lead.nombre || null,
    telefono,
    rubro: lead.rubro || null,
    cantidad_tecnicos: lead.cantidadTecnicos || null,
    m1_enviado: sendResult.ok,
    m1_enviado_at: sendResult.ok ? new Date().toISOString() : null,
    m1_error: sendResult.ok ? null : sendResult.error,
    raw_payload: lead.raw || null,
  });

  if (insertError) {
    // Constraint unique en lead_id: si dos webhooks llegaron en paralelo,
    // el que perdio la carrera no reenvia el M1 (ya se hizo en el otro).
    if (insertError.code === '23505') {
      return { leadId: lead.leadId, skipped: true, reason: 'duplicado' };
    }
    return { leadId: lead.leadId, ok: false, error: 'Error guardando en Supabase: ' + insertError.message, whatsapp: sendResult };
  }

  return { leadId: lead.leadId, ok: sendResult.ok, whatsapp: sendResult };
}

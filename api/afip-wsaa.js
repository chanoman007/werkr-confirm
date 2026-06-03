export const config = {
  regions: ['gru1'],
};

const forge = require('node-forge');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const agent = new https.Agent({ rejectUnauthorized: false });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { empresa_id } = req.body;

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: empresa, error } = await supabase
      .from('empresas')
      .select('afip_cuit, afip_cert, afip_key')
      .eq('id', empresa_id)
      .single();

    if (error || !empresa) return res.status(400).json({ error: 'Empresa no encontrada' });

    const { afip_cert, afip_key, afip_cuit } = empresa;

    console.log('cert inicio:', afip_cert ? afip_cert.substring(0, 50) : 'VACIO');
    console.log('key inicio:', afip_key ? afip_key.substring(0, 50) : 'VACIO');
    console.log('cuit:', afip_cuit);

    if (!afip_cert || !afip_key || !afip_cuit) {
      return res.status(400).json({ error: 'Certificados no configurados' });
    }

    const now  = new Date();
    const from = new Date(now.getTime() - 60000).toISOString();
    const to   = new Date(now.getTime() + 43200000).toISOString();

    const tra = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Date.now()}</uniqueId>
    <generationTime>${from}</generationTime>
    <expirationTime>${to}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;

    const cert       = forge.pki.certificateFromPem(afip_cert);
    const privateKey = forge.pki.privateKeyFromPem(afip_key);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(tra, 'utf8');
    p7.addCertificate(cert);
    p7.addSigner({
      key: privateKey,
      certificate:
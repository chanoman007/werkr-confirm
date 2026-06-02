const forge = require('node-forge');
const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { afip_cert, afip_key, afip_cuit } = req.body;

    if (!afip_cert || !afip_key || !afip_cuit) {
      return res.status(400).json({ error: 'Faltan cert, key o cuit' });
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
      certificate: cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [],
    });
    p7.sign({ detached: false });

    const cmsB64 = forge.util.encode64(
      forge.asn1.toDer(p7.toAsn1()).getBytes()
    );

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov.ar">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsB64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

    const wsaaText = await soapPost(
      'https://wsaahomo.arca.gob.ar/ws/services/LoginCms',
      soapBody,
      agent
    );

    const token = extract(wsaaText, 'token');
    const sign  = extract(wsaaText, 'sign');
    
    console.log('WSAA response:', wsaaText);
    if (!token || !sign) throw new Error(`WSAA error: ${wsaaText}`);

    return res.status(200).json({ ok: true, token, sign });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function soapPost(url, body, agent) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}
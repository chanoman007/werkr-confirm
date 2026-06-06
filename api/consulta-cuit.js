const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { cuit } = req.body;
    if (!cuit || cuit.length !== 11) return res.status(400).json({ error: 'CUIT inválido' });

    // Intentar scraping de CUITONLINE
    const html = await fetchUrl(`https://www.cuitonline.com/search.php?q=${cuit}`, agent);

    // Extraer razón social
    const razonMatch = html.match(/class="denominacion[^"]*"[^>]*>([^<]+)</i);
    const razonSocial = razonMatch ? razonMatch[1].trim() : null;

    // Extraer domicilio
    const domicilioMatch = html.match(/Domicilio[^:]*:\s*<[^>]+>([^<]+)</i);
    const domicilio = domicilioMatch ? domicilioMatch[1].trim() : null;

    // Extraer condición IVA
    let condicionIva = 'consumidor_final';
    if (html.match(/responsable inscripto/i)) condicionIva = 'RI';
    else if (html.match(/monotributo/i)) condicionIva = 'monotributo';
    else if (html.match(/exento/i)) condicionIva = 'exento';

    if (!razonSocial) {
      return res.status(404).json({ error: 'CUIT no encontrado. Ingresá los datos manualmente.' });
    }

    return res.status(200).json({ razon_social: razonSocial, domicilio, condicion_iva: condicionIva });

  } catch (e) {
    return res.status(500).json({ error: 'No se pudo consultar. Ingresá los datos manualmente.' });
  }
};

function fetchUrl(url, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

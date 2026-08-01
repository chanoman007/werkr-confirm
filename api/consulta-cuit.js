const forge = require('node-forge');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const agent = new https.Agent({
  rejectUnauthorized: false,
  ciphers: 'DEFAULT:@SECLEVEL=0',
  secureOptions: require('crypto').constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const WSAA_URL    = 'https://wsaa.arca.gob.ar/ws/services/LoginCms';
const PADRON_URL  = 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5';

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { cuit, empresa_id } = req.body;
    if (!cuit || cuit.replace(/\D/g,'').length < 11) {
      return res.status(400).json({ error: 'CUIT invalido' });
    }
    const cuitLimpio = cuit.replace(/\D/g,'');

    // Obtener cert y key de la empresa
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const { data: empresa } = await supabase
      .from('empresas')
      .select('afip_cuit, afip_cert, afip_key')
      .eq('id', empresa_id)
      .single();

    if (!empresa?.afip_cert || !empresa?.afip_key) {
      return res.status(400).json({ error: 'Empresa sin certificados AFIP configurados' });
    }

    // Obtener token WSAA para ws_sr_constancia_inscripcion
    const { token, sign } = await getToken(empresa.afip_cert, empresa.afip_key, 'ws_sr_constancia_inscripcion');

    // Consultar padrón
    const soapBody = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:per="http://a5.soap.ws.server.puc.sr/">' +
      '<soapenv:Header/><soapenv:Body>' +
      '<per:getPersona>' +
      '<token>' + token + '</token>' +
      '<sign>' + sign + '</sign>' +
      '<cuitRepresentada>' + empresa.afip_cuit + '</cuitRepresentada>' +
      '<idPersona>' + cuitLimpio + '</idPersona>' +
      '</per:getPersona>' +
      '</soapenv:Body></soapenv:Envelope>';

    const respText = await soapPost(PADRON_URL, soapBody, 'getPersona');

    // Parsear respuesta
    const razonSocialMatch = respText.match(/<razonSocial>([^<]+)<\/razonSocial>/) ||
                             respText.match(/<apellido>([^<]+)<\/apellido>/);
    const nombreMatch      = respText.match(/<nombre>([^<]+)<\/nombre>/);
    const calleMatch       = respText.match(/<direccion>([^<]+)<\/direccion>/) ||
                             respText.match(/<calle>([^<]+)<\/calle>/);
    const localidadMatch   = respText.match(/<localidad>([^<]+)<\/localidad>/);
    let razonSocial = decodeEntities(razonSocialMatch?.[1] || '');
    if (nombreMatch?.[1]) razonSocial = (razonSocial + ' ' + decodeEntities(nombreMatch[1])).trim();

    const domicilio = decodeEntities([calleMatch?.[1], localidadMatch?.[1]].filter(Boolean).join(', '));

    // La condición frente al IVA no viene en un campo único: hay que inferirla de los
    // impuestos/regímenes en los que la persona está inscripta (datosRegimenGeneral / datosMonotributo).
    // El nodo <datosMonotributo> puede venir presente pero vacío para quien no está adherido,
    // por eso se exige que tenga contenido adentro (no solo que exista la etiqueta).
    const monotributoMatch = respText.match(/<datosMonotributo>([\s\S]*?)<\/datosMonotributo>/);
    const tieneMonotributo = !!(monotributoMatch && monotributoMatch[1].trim().length > 0);
    const impuestosIds = Array.from(respText.matchAll(/<idImpuesto>(\d+)<\/idImpuesto>/g)).map((m) => m[1]);
    const descripcionesImpuesto = Array.from(respText.matchAll(/<descripcionImpuesto>([^<]+)<\/descripcionImpuesto>/g))
      .map((m) => m[1].toLowerCase());

    let condicionIva = 'consumidor_final';
    if (tieneMonotributo) {
      condicionIva = 'monotributo';
    } else if (impuestosIds.includes('32') || descripcionesImpuesto.some((d) => d.includes('exento'))) {
      condicionIva = 'exento';
    } else if (impuestosIds.includes('30') || descripcionesImpuesto.some((d) => d.includes('iva'))) {
      condicionIva = 'RI';
    }

    if (!razonSocial) {
      return res.status(404).json({ error: 'CUIT no encontrado en ARCA' });
    }

    return res.status(200).json({ razon_social: razonSocial, domicilio, condicion_iva: condicionIva });

  } catch (e) {
    console.log('ERROR consulta-cuit:', e.message);
    return res.status(500).json({ error: 'No se pudo consultar. Ingresa los datos manualmente.' });
  }
};

async function getToken(afip_cert, afip_key, servicio) {
  const now  = new Date();
  const from = toARCADate(new Date(now.getTime() - 60000));
  const to   = toARCADate(new Date(now.getTime() + 43200000));
  const uid  = Math.floor(now.getTime() / 1000);

  const tra = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>' + uid + '</uniqueId><generationTime>' + from + '</generationTime><expirationTime>' + to + '</expirationTime></header><service>' + servicio + '</service></loginTicketRequest>';

  const cert       = forge.pki.certificateFromPem(afip_cert);
  const privateKey = forge.pki.privateKeyFromPem(afip_key);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({ key: privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256, authenticatedAttributes: [] });
  p7.sign({ detached: false });
  const cms = forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());

  const wsaaSoap = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov.ar"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>' + cms + '</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>';

  const wsaaText = await soapPost(WSAA_URL, wsaaSoap, '');
  const decoded = wsaaText.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  const token = extract(decoded, 'token');
  const sign  = extract(decoded, 'sign');
  if (!token || !sign) throw new Error('WSAA error');
  return { token, sign };
}

function soapPost(url, body, action) {
  return new Promise(function(resolve, reject) {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', agent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': action || '',
        'Content-Length': Buffer.byteLength(body),
      }
    }, function(res) {
      let d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(d); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function toARCADate(d) {
  const p = function(n) { return String(n).padStart(2,'0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth()+1) + '-' + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + '-00:00';
}

function extract(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? m[1].trim() : '';
}

const forge = require('node-forge');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const agent = new https.Agent({ rejectUnauthorized: false, ciphers: 'DEFAULT:@SECLEVEL=0', secureOptions: require('crypto').constants.SSL_OP_LEGACY_SERVER_CONNECT });
const WSFE_URL = 'https://servicios1.arca.gob.ar/wsfev1/service.asmx';
const WSAA_URL = 'https://wsaa.arca.gob.ar/ws/services/LoginCms';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { empresa_id, trabajo_id, importe, concepto, receptor } = req.body;

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: empresa, error } = await supabase
      .from('empresas')
      .select('afip_cuit, afip_cert, afip_key, afip_punto_venta, afip_condicion')
      .eq('id', empresa_id)
      .single();

    if (error || !empresa) return res.status(400).json({ error: 'Empresa no encontrada' });

    const ptoVta = empresa.afip_punto_venta;
    const cuitEmisor = empresa.afip_cuit;
    const tipoComprobante = getTipoComprobante(empresa.afip_condicion, receptor.condicion);

    // WSAA inline
    const { token, sign } = await getToken(empresa.afip_cert, empresa.afip_key);

    // Ultimo numero
    const ultimoNroSoap = buildSoapUltimoNro(cuitEmisor, token, sign, ptoVta, tipoComprobante);
    const ultimoNroText = await soapPost(WSFE_URL, ultimoNroSoap, 'FECompUltimoAutorizado');
    const ultimoNro = parseInt(extract(ultimoNroText, 'CbteNro')) || 0;
    const nroComprobante = ultimoNro + 1;

    // Importes
    const fecha = getFechaHoy();
    const importeTotal = parseFloat(parseFloat(importe).toFixed(2));
    const importeNeto = tipoComprobante === 11
      ? importeTotal
      : parseFloat((importeTotal / 1.21).toFixed(2));
    const iva = tipoComprobante === 11
      ? 0
      : parseFloat((importeTotal - importeNeto).toFixed(2));

    // Emitir
    const emisorSoap = buildSoapEmitir(
      cuitEmisor, token, sign, ptoVta, tipoComprobante,
      nroComprobante, fecha, importeNeto, iva, importeTotal,
      receptor.cuit || '0', concepto || 1, receptor.condicion
    );
    const emisorText = await soapPost(WSFE_URL, emisorSoap, 'FECAESolicitar');

    console.log('WSFEv1 response:', emisorText);

    const cae = extract(emisorText, 'CAE');
    const caeVto = extract(emisorText, 'CAEFchVto');
    const resultado = extract(emisorText, 'Resultado');
    const errMsg = extract(emisorText, 'Msg');

    if (!cae || resultado !== 'A') throw new Error('WSFEv1 error: ' + (errMsg || emisorText));

    if (trabajo_id) {
      await supabase.from('trabajos').update({
        cae,
        cae_vencimiento: caeVto,
        factura_numero: nroComprobante,
        factura_tipo: getTipoLetra(tipoComprobante),
        receptor_condicion: receptor.condicion,
      }).eq('id', trabajo_id);
    }

    return res.status(200).json({
      ok: true,
      cae,
      cae_vencimiento: caeVto,
      factura_numero: nroComprobante,
      factura_tipo: getTipoLetra(tipoComprobante),
      importe_total: importeTotal,
    });

  } catch (e) {
    console.log('ERROR wsfe:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

async function getToken(afip_cert, afip_key) {
  const now  = new Date();
  const from = toARCADate(new Date(now.getTime() - 60000));
  const to   = toARCADate(new Date(now.getTime() + 43200000));
  const uid  = Math.floor(now.getTime() / 1000);

  const tra = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>' + uid + '</uniqueId><generationTime>' + from + '</generationTime><expirationTime>' + to + '</expirationTime></header><service>wsfe</service></loginTicketRequest>';

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
  const cmsB64 = forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());

  const soapBody = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov.ar"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>' + cmsB64 + '</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>';

  const wsaaText = await soapPost(WSAA_URL, soapBody, '');
  const decoded = wsaaText.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const token = extract(decoded, 'token');
  const sign  = extract(decoded, 'sign');
  if (!token || !sign) throw new Error('WSAA error: ' + wsaaText);
  return { token, sign };
}

function getTipoComprobante(condicionEmisor, condicionReceptor) {
  if (condicionEmisor === 'ri' && condicionReceptor === 'RI') return 1;
  if (condicionEmisor === 'ri') return 6;
  return 11;
}

function getTipoLetra(tipo) {
  if (tipo === 1) return 'A';
  if (tipo === 6) return 'B';
  return 'C';
}

function getFechaHoy() {
  const d = new Date();
  const pad = function(n) { return String(n).padStart(2, '0'); };
  return '' + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate());
}

function toARCADate(d) {
  const pad = function(n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '-00:00';
}

function buildSoapUltimoNro(cuit, token, sign, ptoVta, tipoCbte) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body><FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">' +
    '<Auth><Token>' + token + '</Token><Sign>' + sign + '</Sign><Cuit>' + cuit + '</Cuit></Auth>' +
    '<PtoVta>' + ptoVta + '</PtoVta><CbteTipo>' + tipoCbte + '</CbteTipo>' +
    '</FECompUltimoAutorizado></soap:Body></soap:Envelope>';
}

function buildSoapEmitir(cuit, token, sign, ptoVta, tipoCbte, nro, fecha, neto, iva, total, cuitReceptor, concepto, receptor_condicion) {
  const ivaXml = tipoCbte !== 11
    ? '<AlicIvas><AlicIva><Id>5</Id><BaseImp>' + neto + '</BaseImp><Importe>' + iva + '</Importe></AlicIva></AlicIvas>'
    : '<AlicIvas/>';

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body><FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">' +
    '<Auth><Token>' + token + '</Token><Sign>' + sign + '</Sign><Cuit>' + cuit + '</Cuit></Auth>' +
    '<FeCAEReq>' +
    '<FeCabReq><CantReg>1</CantReg><PtoVta>' + ptoVta + '</PtoVta><CbteTipo>' + tipoCbte + '</CbteTipo></FeCabReq>' +
    '<FeDetReq><FECAEDetRequest>' +
    '<Concepto>' + concepto + '</Concepto>' +
    '<DocTipo>' + (cuitReceptor !== '0' ? '80' : '99') + '</DocTipo>' +
    '<DocNro>' + cuitReceptor + '</DocNro>' +
    '<CondicionIVAReceptorId>' + getCondicionIVA(receptor_condicion) + '</CondicionIVAReceptorId>' +
    '<CbteDesde>' + nro + '</CbteDesde>' +
    '<CbteHasta>' + nro + '</CbteHasta>' +
    '<CbteFch>' + fecha + '</CbteFch>' +
    '<ImpTotal>' + total + '</ImpTotal>' +
    '<ImpTotConc>0</ImpTotConc>' +
    '<ImpNeto>' + neto + '</ImpNeto>' +
    '<ImpOpEx>0</ImpOpEx>' +
    '<ImpIVA>' + iva + '</ImpIVA>' +
    '<ImpTrib>0</ImpTrib>' +
    '<MonId>PES</MonId>' +
    '<MonCotiz>1</MonCotiz>' +
    ivaXml +
    '</FECAEDetRequest></FeDetReq>' +
    '</FeCAEReq>' +
    '</FECAESolicitar></soap:Body></soap:Envelope>';
}

function soapPost(url, body, action) {
  return new Promise(function(resolve, reject) {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      agent: agent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': action ? 'http://ar.gov.afip.dif.FEV1/' + action : '',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getCondicionIVA(condicion) {
  if (condicion === 'RI') return 1;
  if (condicion === 'exento') return 4;
  if (condicion === 'monotributo') return 6;
  return 5; // consumidor_final por defecto
}

function extract(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? m[1].trim() : '';
}

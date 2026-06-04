const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const agent = new https.Agent({ rejectUnauthorized: false });

const WSFE_URL = 'https://wswhomo.arca.gob.ar/wsfev1/service.asmx';
const WSAA_URL = 'https://werkr-confirm.vercel.app/api/afip-wsaa';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { empresa_id, trabajo_id, importe, concepto, receptor } = req.body;
    // receptor: { nombre, cuit, condicion } condicion: 'RI' | 'monotributo' | 'consumidor_final'

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // 1. Obtener datos de la empresa
    const { data: empresa, error } = await supabase
      .from('empresas')
      .select('afip_cuit, afip_cert, afip_key, afip_punto_venta, afip_condicion')
      .eq('id', empresa_id)
      .single();

    if (error || !empresa) return res.status(400).json({ error: 'Empresa no encontrada' });

    const ptoVta = empresa.afip_punto_venta;
    const cuitEmisor = empresa.afip_cuit;

    // 2. Determinar tipo de factura
    const tipoComprobante = getTipoComprobante(empresa.afip_condicion, receptor.condicion);

    // 3. Obtener token y sign del WSAA
    const wsaaResp = await fetch(WSAA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id }),
    });
    const wsaaData = await wsaaResp.json();
    if (!wsaaData.token || !wsaaData.sign) throw new Error('WSAA error: ' + JSON.stringify(wsaaData));

    const { token, sign } = wsaaData;

    // 4. Obtener último número de comprobante
    const ultimoNroSoap = buildSoapUltimoNro(cuitEmisor, token, sign, ptoVta, tipoComprobante);
    const ultimoNroText = await soapPost(WSFE_URL, ultimoNroSoap, 'FECompUltimoAutorizado', agent);
    const ultimoNro = parseInt(extract(ultimoNroText, 'CbteNro')) || 0;
    const nroComprobante = ultimoNro + 1;

    // 5. Emitir factura
    const fecha = getFechaHoy();
    const importeNeto = parseFloat(importe);
    const iva = tipoComprobante === 1 ? parseFloat((importeNeto * 0.21).toFixed(2)) : 0;
    const importeTotal = tipoComprobante === 1 ? parseFloat((importeNeto + iva).toFixed(2)) : importeNeto;

    const emisorSoap = buildSoapEmitir(
      cuitEmisor, token, sign, ptoVta, tipoComprobante,
      nroComprobante, fecha, importeNeto, iva, importeTotal,
      receptor.cuit || '0', concepto || 1
    );

    const emisorText = await soapPost(WSFE_URL, emisorSoap, 'FECAESolicitar', agent);

    console.log('WSFEv1 response:', emisorText);

    const cae = extract(emisorText, 'CAE');
    const caeVto = extract(emisorText, 'CAEFchVto');
    const resultado = extract(emisorText, 'Resultado');
    const errMsg = extract(emisorText, 'Msg');

    if (!cae || resultado !== 'A') {
      throw new Error('WSFEv1 error: ' + (errMsg || emisorText));
    }

    // 6. Guardar CAE en el trabajo
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

function getTipoComprobante(condicionEmisor, condicionReceptor) {
  if (condicionEmisor === 'ri' && condicionReceptor === 'RI') return 1;  // Factura A
  if (condicionEmisor === 'ri') return 6;                                  // Factura B
  return 11;                                                               // Factura C
}

function getTipoLetra(tipo) {
  if (tipo === 1) return 'A';
  if (tipo === 6) return 'B';
  return 'C';
}

function getFechaHoy() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate());
}

function buildSoapUltimoNro(cuit, token, sign, ptoVta, tipoCbte) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body>' +
    '<FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">' +
    '<Auth><Token>' + token + '</Token><Sign>' + sign + '</Sign><Cuit>' + cuit + '</Cuit></Auth>' +
    '<PtoVta>' + ptoVta + '</PtoVta>' +
    '<CbteTipo>' + tipoCbte + '</CbteTipo>' +
    '</FECompUltimoAutorizado>' +
    '</soap:Body></soap:Envelope>';
}

function buildSoapEmitir(cuit, token, sign, ptoVta, tipoCbte, nro, fecha, neto, iva, total, cuitReceptor, concepto) {
  const ivaXml = tipoCbte === 1
    ? '<AlicIvas><AlicIva><Id>5</Id><BaseImp>' + neto + '</BaseImp><Importe>' + iva + '</Importe></AlicIva></AlicIvas>'
    : '<AlicIvas/>';

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body>' +
    '<FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">' +
    '<Auth><Token>' + token + '</Token><Sign>' + sign + '</Sign><Cuit>' + cuit + '</Cuit></Auth>' +
    '<FeCAEReq>' +
    '<FeCabReq><CantReg>1</CantReg><PtoVta>' + ptoVta + '</PtoVta><CbteTipo>' + tipoCbte + '</CbteTipo></FeCabReq>' +
    '<FeDetReq><FECAEDetRequest>' +
    '<Concepto>' + concepto + '</Concepto>' +
    '<DocTipo>' + (cuitReceptor !== '0' ? '80' : '99') + '</DocTipo>' +
    '<DocNro>' + cuitReceptor + '</DocNro>' +
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
    '</FECAESolicitar>' +
    '</soap:Body></soap:Envelope>';
}

function soapPost(url, body, action, agent) {
  return new Promise(function(resolve, reject) {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      agent: agent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://ar.gov.afip.dif.FEV1/' + action,
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

function extract(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? m[1].trim() : '';
}

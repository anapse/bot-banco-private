/* ============================================================================
 * RUTAS DEL FLUJO APK — extraidas del analisis de libapp.so
 * ----------------------------------------------------------------------------
 * Cada ruta fue localizada en el binario (offset indicado). NO hay ninguna ruta
 * inventada ni copiada del portal bdvenlinea.
 *
 * El orden de `RUTAS` refleja el orden REAL de aparicion en el binario.
 * ========================================================================== */
'use strict';

const RUTAS = {
  // ------------------------------- AUTH -----------------------------------
  oauthToken:       '/bdvx-oauth-server/oauth/token',                       // @205950
  oauthPassword:    '/bdvx-oauth-server/oauth/token?grant_type=password',    // literal en binario
  oauthRefresh:     '/bdvx-oauth-server/oauth/token?grant_type=refresh_token',

  // ------------------------------ CUENTAS ---------------------------------
  saldoV2:          '/bdvx-consulta-cuenta-v2/v1/cuenta/saldo-v2',          // @189676
  cliente:          '/bdvx-detalles-cliente/cliente/',                      // @261417
  movimientos:      '/bdvx-consulta-historico-operaciones/v1/movimientos',  // @213980
  operacionesDivisas:'/bdvx-consulta-historico-operaciones/v1/operaciones/divisas',

  // --------------------------- INTERVENCION -------------------------------
  intervencionInit: '/bdvx-intervencion-cambiaria/v1/intervencion/init',                          // hallado
  consultarReglasEXRI:'/bdvx-intervencion-cambiaria/v1/intervencion/consultarReglasEXRI',         // @412596

  // ------------------------- OPERACIONES CAMBIARIAS -----------------------
  consultarReglas:  '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas',          // @397554
  reglasCompra:     '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra',   // @254223
  actividades:      '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades',     // @329868
  estados:          '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/estados',         // @191567
  oficinas:         '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/oficinas',        // @408836
  retiroConsultaReglas:'/bdvx-operaciones-cambiarias/v1/operaciones/retiro/consulta-reglas', // @238270
  comprar:          '/bdvx-operaciones-cambiarias/v1/operaciones/comprar',                   // @384052
  confirmar:        '/bdvx-operaciones-cambiarias/v1/operaciones/confirmar',                 // @252674
  confirmarRetiro:  '/bdvx-operaciones-cambiarias/v1/operaciones/confirmar/retiro',          // @185327
  vender:           '/bdvx-operaciones-cambiarias/v1/operaciones/vender',                    // @394369
  retiro:           '/bdvx-operaciones-cambiarias/v1/operaciones/retiro',                    // @464556

  // ------------------------------- MERCADO --------------------------------
  mercado:          '/bdvx-menudeo-v2/v1/mercado',     // @382631
  transar:          '/bdvx-menudeo-v2/v1/transar',     // @447831

  // ------------------------------- APOYO ----------------------------------
  detallesVersion:  '/bdvx-consultas-generales/v1/detalles-version',
};

/** Flujo completo que sigue la APK, en el orden extraido del binario. */
const FLUJO = [
  { fase: 'LOGIN',           ruta: 'oauthToken',        metodo: 'POST', auth: false },
  { fase: 'SALDO',           ruta: 'saldoV2',           metodo: 'GET',  auth: true  },
  { fase: 'CLIENTE',         ruta: 'cliente',           metodo: 'GET',  auth: true  },
  { fase: 'INTERVENCION_INIT', ruta: 'intervencionInit', metodo: 'POST', auth: true },
  { fase: 'EXRI',            ruta: 'consultarReglasEXRI', metodo: 'POST', auth: true },
  { fase: 'MERCADO',         ruta: 'mercado',           metodo: 'GET',  auth: true  },
  { fase: 'REGLAS',          ruta: 'consultarReglas',   metodo: 'GET',  auth: true  },
  { fase: 'REGLAS_COMPRA',   ruta: 'reglasCompra',      metodo: 'GET',  auth: true  },
  { fase: 'ACTIVIDADES',     ruta: 'actividades',       metodo: 'GET',  auth: true  },
  { fase: 'ESTADOS',         ruta: 'estados',           metodo: 'GET',  auth: true  },
  { fase: 'OFICINAS',        ruta: 'oficinas',          metodo: 'GET',  auth: true  },
];

module.exports = { RUTAS, FLUJO };

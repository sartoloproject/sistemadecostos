// Se ejecuta ANTES de cualquier request al sitio (páginas y API por igual).
// Pide usuario/contraseña con el diálogo nativo del navegador (HTTP Basic
// Auth) — no requiere Zero Trust ni ningún servicio que pida tarjeta.
//
// Configurar en Cloudflare Pages → Settings → Environment variables:
//   APP_USER      (Secret)
//   APP_PASSWORD  (Secret)

export async function onRequest(context) {
  const { request, env, next } = context;

  const usuarioEsperado = env.APP_USER;
  const claveEsperada = env.APP_PASSWORD;

  // si todavía no se configuraron las variables, no bloqueamos nada
  // (evita dejarte afuera por error antes de terminar de configurar)
  if (!usuarioEsperado || !claveEsperada) {
    return next();
  }

  const encabezadoAuth = request.headers.get("Authorization");
  const credencialEsperada = "Basic " + btoa(`${usuarioEsperado}:${claveEsperada}`);

  if (encabezadoAuth !== credencialEsperada) {
    return new Response("Autenticación requerida", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Sistema de Facturas"',
      },
    });
  }

  return next();
}

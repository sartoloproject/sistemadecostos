// Protege todo el sitio (páginas y API) con una pantalla de login propia,
// usando una cookie de sesión. No depende de Zero Trust ni de ningún
// servicio que pida tarjeta — solo variables de entorno tipo "Secret".
//
// Configurar en Cloudflare Pages → Settings → Environment variables:
//   APP_USER            (Secret) — el usuario para entrar
//   APP_PASSWORD        (Secret) — la contraseña
//   APP_SESSION_SECRET   (Secret) — cualquier cadena larga al azar (no es
//                         un usuario/contraseña, es solo el "sello" que
//                         se guarda en la cookie del navegador)

const NOMBRE_COOKIE = "sesion_facturas";

function parsearCookie(header, nombre) {
  if (!header) return null;
  const partes = header.split(";").map((p) => p.trim());
  for (const parte of partes) {
    const igual = parte.indexOf("=");
    if (igual === -1) continue;
    if (parte.slice(0, igual) === nombre) return parte.slice(igual + 1);
  }
  return null;
}

function paginaLogin(huboError) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Iniciar sesión — Sistema de Facturas</title>
<style>
  :root { --verde:#3f6b4f; --borde:#dedcd3; --bg:#f6f5f1; --texto-muted:#6b6f6a; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display:flex; align-items:center; justify-content:center;
    background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .tarjeta {
    background:#fff; border:1px solid var(--borde); border-radius:14px; padding:36px 32px;
    width: 320px; box-shadow: 0 8px 24px rgba(0,0,0,0.06);
  }
  h1 { font-size:19px; margin:0 0 4px; color:#1f2320; }
  p.subt { color: var(--texto-muted); font-size:13px; margin:0 0 22px; }
  label { display:block; font-size:13px; margin-bottom:6px; color:#1f2320; font-weight:600; }
  input {
    width:100%; padding:10px 12px; margin-bottom:16px; border:1px solid var(--borde);
    border-radius:8px; font-size:14px;
  }
  button {
    width:100%; padding:11px; background:var(--verde); color:#fff; border:none;
    border-radius:8px; font-size:14px; font-weight:600; cursor:pointer;
  }
  button:hover { opacity:0.92; }
  .error {
    background:#fdeceb; color:#a83a30; border:1px solid #f3c8c4; padding:10px 12px;
    border-radius:8px; font-size:13px; margin-bottom:16px;
  }
</style>
</head>
<body>
  <form class="tarjeta" method="POST" action="/login">
    <h1>Sistema de Gestión de Facturas</h1>
    <p class="subt">Ingresá tus credenciales para continuar</p>
    ${huboError ? `<div class="error">Usuario o contraseña incorrectos</div>` : ""}
    <label for="usuario">Usuario</label>
    <input id="usuario" name="usuario" type="text" autocomplete="username" autofocus required>
    <label for="clave">Contraseña</label>
    <input id="clave" name="clave" type="password" autocomplete="current-password" required>
    <button type="submit">Iniciar sesión</button>
  </form>
</body>
</html>`;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const usuarioEsperado = env.APP_USER;
  const claveEsperada = env.APP_PASSWORD;
  const secretoSesion = env.APP_SESSION_SECRET;

  // si falta configurar algo, no bloqueamos nada (para no dejarte afuera
  // por error antes de terminar de configurar las 3 variables)
  if (!usuarioEsperado || !claveEsperada || !secretoSesion) {
    return next();
  }

  // --- procesa el envío del formulario de login ---
  if (url.pathname === "/login" && request.method === "POST") {
    const formData = await request.formData();
    const usuario = formData.get("usuario");
    const clave = formData.get("clave");

    if (usuario === usuarioEsperado && clave === claveEsperada) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `${NOMBRE_COOKIE}=${secretoSesion}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }

    return new Response(paginaLogin(true), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // --- muestra el formulario de login ---
  if (url.pathname === "/login" && request.method === "GET") {
    return new Response(paginaLogin(false), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // --- cierre de sesión ---
  if (url.pathname === "/logout") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login",
        "Set-Cookie": `${NOMBRE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  // --- cualquier otra ruta: exige la cookie de sesión válida ---
  const cookieSesion = parsearCookie(request.headers.get("Cookie"), NOMBRE_COOKIE);

  if (cookieSesion !== secretoSesion) {
    const aceptaHtml = (request.headers.get("Accept") || "").includes("text/html");
    if (aceptaHtml) {
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
    return new Response("No autenticado", { status: 401 });
  }

  return next();
}
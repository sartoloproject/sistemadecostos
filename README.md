# Sistema de Gestión de Facturas

Carga de facturas de proveedores (lectura del QR de AFIP + texto del PDF
en el navegador), imputación de ítems a objetos de costo (maquinaria,
vehículos, lotes, gastos generales) y resumen de cuenta por proveedor.

Stack: **Cloudflare Pages** (frontend estático) + **Pages Functions**
(backend serverless) + **D1** (base de datos SQLite) + **R2** (storage
de los PDFs). Todo dentro de los planes gratuitos de Cloudflare.

## 1. Requisitos

- Cuenta de Cloudflare (gratis) — https://dash.cloudflare.com/sign-up
- Cuenta de GitHub
- Node.js instalado localmente (para usar `wrangler`)

## 2. Subir este repo a GitHub

```bash
git init
git add .
git commit -m "Sistema de gestión de facturas - versión inicial"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

## 3. Instalar Wrangler (CLI de Cloudflare) y loguearte

```bash
npm install
npx wrangler login
```

## 4. Crear la base de datos D1

```bash
npx wrangler d1 create facturas-db
```

Esto te devuelve un `database_id`. Copialo y pegalo en `wrangler.toml`,
reemplazando `REEMPLAZAR_CON_TU_DATABASE_ID`.

Cargar el esquema:

```bash
npm run db:init:remote
```

## 5. Crear el bucket R2 (para los PDFs)

```bash
npx wrangler r2 bucket create facturas-pdfs
```

## 6. Conectar el repo de GitHub a Cloudflare Pages

1. En el dashboard de Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Elegí este repositorio.
3. Configuración de build:
   - **Build command**: (dejar vacío, no hay build)
   - **Build output directory**: `public`
4. Una vez creado el proyecto, andá a **Settings → Functions** y agregá los bindings:
   - **D1 database binding**: nombre `DB` → tu base `facturas-db`
   - **R2 bucket binding**: nombre `FACTURAS_BUCKET` → tu bucket `facturas-pdfs`
5. Guardá y hacé **Retry deployment** para que tome los bindings.

Desde acá, cada `git push` a `main` dispara un deploy automático.

## 7. Desarrollo local

```bash
npm run dev
```

Esto levanta el sitio en `http://localhost:8788` con D1 y R2 simulados
localmente (los datos locales no afectan a los remotos).

## Estructura del repo

```
schema/schema.sql          -> esquema de la base D1
functions/api/...          -> endpoints del backend (Pages Functions)
public/index.html          -> interfaz (pestañas: cargar, objetos de costo, imputar, resumen)
public/app.js              -> lógica del frontend, incluida la lectura de QR/texto del PDF
public/style.css
wrangler.toml               -> configuración de Cloudflare (bindings de D1 y R2)
```

## Cómo funciona la carga de una factura

1. El navegador lee el PDF con `pdf.js`, renderiza cada página y busca
   un código QR con `jsQR`. El QR de AFIP trae los datos fiscales
   (CUIT, tipo de comprobante, número, fecha, importe, CAE) en un JSON
   codificado en base64 — no depende del formato visual del proveedor.
2. En paralelo se extrae el texto del PDF y se intenta detectar los
   ítems de forma heurística (líneas con al menos 3 números).
3. Todo lo detectado se muestra en una tabla **editable** — corregís lo
   que haga falta antes de guardar.
4. Al guardar, el PDF se sube a R2 y los datos van a `/api/facturas`,
   que resuelve (o crea) el proveedor por CUIT e inserta la factura y
   sus ítems en D1.
5. Desde la pestaña **Imputar**, indicás a qué objeto de costo
   (maquinaria/vehículo/lote/gasto general) corresponde cada ítem, por
   cantidad o por porcentaje — se puede repartir un mismo ítem entre
   varios objetos.

## Pendiente / próximos pasos sugeridos

- Selector de proveedor y de factura por nombre en vez de por ID (hoy
  hay que escribir el ID a mano).
- Autenticación (hoy la API queda abierta a quien tenga la URL).
- Aprendizaje de plantillas por proveedor (guardar en
  `plantillas_extraccion` qué encabezados usa cada proveedor para
  mejorar la detección automática de ítems con el tiempo).
- Exportación de informes de IVA para el contador.

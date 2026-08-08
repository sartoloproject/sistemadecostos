-- ============================================================
-- SISTEMA DE GESTIÓN DE FACTURAS — esquema para Cloudflare D1 (SQLite)
-- Cargar con: wrangler d1 execute facturas-db --file=./schema/schema.sql
-- ============================================================

CREATE TABLE proveedores (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cuit                TEXT NOT NULL UNIQUE,
    razon_social        TEXT NOT NULL,
    nombre_fantasia     TEXT,
    condicion_iva       TEXT,
    email               TEXT,
    telefono            TEXT,
    direccion           TEXT,
    rubro               TEXT,
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plantillas_extraccion (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id        INTEGER NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
    version             INTEGER NOT NULL DEFAULT 1,
    config_json         TEXT NOT NULL,          -- JSON serializado como string
    activa              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (proveedor_id, version)
);

CREATE TABLE tipos_comprobante (
    codigo              TEXT PRIMARY KEY,
    descripcion         TEXT NOT NULL
);

CREATE TABLE facturas (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id        INTEGER NOT NULL REFERENCES proveedores(id),
    tipo_cbte           TEXT NOT NULL REFERENCES tipos_comprobante(codigo),
    punto_venta         TEXT NOT NULL,
    numero              TEXT NOT NULL,
    fecha_emision       TEXT NOT NULL,          -- 'YYYY-MM-DD'
    fecha_vencimiento   TEXT,
    cae                 TEXT,
    cae_vencimiento     TEXT,
    moneda              TEXT NOT NULL DEFAULT 'ARS',
    subtotal_neto       REAL NOT NULL DEFAULT 0,
    total_iva           REAL NOT NULL DEFAULT 0,
    total               REAL NOT NULL DEFAULT 0,
    estado_pago         TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente, parcial, pagada
    origen_extraccion   TEXT NOT NULL DEFAULT 'qr',          -- qr, qr_items_pendientes, manual
    archivo_url         TEXT,                                -- key del objeto en R2
    plantilla_id        INTEGER REFERENCES plantillas_extraccion(id),
    creado_en           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (proveedor_id, tipo_cbte, punto_venta, numero)
);

CREATE TABLE notas_credito_debito (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id        INTEGER NOT NULL REFERENCES proveedores(id),
    factura_asociada_id INTEGER REFERENCES facturas(id),
    tipo                TEXT NOT NULL,           -- credito, debito
    numero              TEXT NOT NULL,
    fecha_emision       TEXT NOT NULL,
    total               REAL NOT NULL,
    motivo              TEXT,
    creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE factura_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id          INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
    descripcion         TEXT NOT NULL,
    cantidad            REAL NOT NULL,
    unidad_medida       TEXT NOT NULL,
    precio_unitario     REAL NOT NULL,
    alicuota_iva        REAL NOT NULL,
    subtotal            REAL NOT NULL,          -- neto, sin IVA
    subtotal_con_iva    REAL,                   -- con IVA incluido (si se pudo detectar)
    imputado_completo   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE objetos_costo (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo                TEXT NOT NULL,           -- maquinaria, vehiculo, lote, gasto_general
    nombre              TEXT NOT NULL,
    identificador       TEXT,                    -- patente, nro interno, código de lote
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE categorias (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre              TEXT NOT NULL UNIQUE,
    categoria_padre_id  INTEGER REFERENCES categorias(id)
);

CREATE TABLE imputaciones (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id             INTEGER NOT NULL REFERENCES factura_items(id) ON DELETE CASCADE,
    objeto_costo_id     INTEGER NOT NULL REFERENCES objetos_costo(id),
    categoria_id        INTEGER REFERENCES categorias(id),
    cantidad_imputada   REAL,
    porcentaje          REAL,
    monto_imputado      REAL NOT NULL,
    nota                TEXT,
    creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pagos (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id        INTEGER NOT NULL REFERENCES proveedores(id),
    fecha_pago          TEXT NOT NULL,
    monto               REAL NOT NULL,
    medio_pago          TEXT,
    referencia          TEXT,
    creado_en           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pago_factura (
    pago_id             INTEGER NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
    factura_id          INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
    monto_aplicado      REAL NOT NULL,
    PRIMARY KEY (pago_id, factura_id)
);

CREATE INDEX idx_facturas_proveedor ON facturas(proveedor_id);
CREATE INDEX idx_facturas_fecha ON facturas(fecha_emision);
CREATE INDEX idx_items_factura ON factura_items(factura_id);
CREATE INDEX idx_imputaciones_objeto ON imputaciones(objeto_costo_id);
CREATE INDEX idx_imputaciones_item ON imputaciones(item_id);

INSERT INTO tipos_comprobante (codigo, descripcion) VALUES
    ('001', 'Factura A'),
    ('006', 'Factura B'),
    ('011', 'Factura C'),
    ('003', 'Nota de Crédito A'),
    ('008', 'Nota de Crédito B'),
    ('013', 'Nota de Crédito C'),
    ('002', 'Nota de Débito A'),
    ('007', 'Nota de Débito B'),
    ('012', 'Nota de Débito C');

-- ------------------------------------------------------------
-- VISTAS
-- ------------------------------------------------------------
CREATE VIEW vw_gasto_por_objeto_costo AS
SELECT
    oc.id AS objeto_costo_id,
    oc.tipo,
    oc.nombre,
    SUM(im.monto_imputado) AS total_imputado,
    COUNT(DISTINCT fi.factura_id) AS cantidad_facturas
FROM imputaciones im
JOIN objetos_costo oc ON oc.id = im.objeto_costo_id
JOIN factura_items fi ON fi.id = im.item_id
GROUP BY oc.id, oc.tipo, oc.nombre;

CREATE VIEW vw_saldo_proveedor AS
SELECT
    p.id AS proveedor_id,
    p.razon_social,
    COALESCE((SELECT SUM(f.total) FROM facturas f WHERE f.proveedor_id = p.id), 0) AS total_facturado,
    COALESCE((
        SELECT SUM(pf.monto_aplicado)
        FROM pago_factura pf JOIN facturas f2 ON f2.id = pf.factura_id
        WHERE f2.proveedor_id = p.id
    ), 0) AS total_pagado,
    COALESCE((SELECT SUM(f.total) FROM facturas f WHERE f.proveedor_id = p.id), 0) -
    COALESCE((
        SELECT SUM(pf.monto_aplicado)
        FROM pago_factura pf JOIN facturas f2 ON f2.id = pf.factura_id
        WHERE f2.proveedor_id = p.id
    ), 0) AS saldo_pendiente
FROM proveedores p;
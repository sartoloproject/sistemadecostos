-- Ejecutar esto en la Console de D1 (dashboard de Cloudflare) UNA sola vez.
-- Agrega la columna nueva sin borrar los datos ya cargados.

ALTER TABLE factura_items ADD COLUMN subtotal_con_iva REAL;

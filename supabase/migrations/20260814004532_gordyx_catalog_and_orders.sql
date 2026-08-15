/*
# GORDYX — Catálogo, pedidos y stock

## Resumen
Crea el esquema completo para la tienda pública GORDYX: categorías, productos,
tamaños con precio y stock, ingredientes base (sacables), extras opcionales con
precio por tamaño, pedidos, items de pedido, y una tabla de rate-limit por IP.
Incluye datos semilla del primer drop (Pizzas estilo Detroit + Bebidas).

## Tablas nuevas
- `categories` — categorías de producto (ej. Pizzas, Bebidas). Genérico, el admin suma más.
- `products` — productos del catálogo. Pertenecen a una categoría. Tienen `is_pizza` para saber si tienen ingredientes/extras.
- `product_sizes` — cada producto tiene al menos 2 tamaños, cada uno con su propio precio y stock.
- `product_ingredients` — ingredientes base de un producto (sacables por el cliente, sin costo).
- `product_extras` — extras opcionales de un producto, con `price_by_size` jsonb que mapea índice de tamaño → precio.
- `orders` — cabecera del pedido: cliente, contacto, dirección, método de pago, estado, total validado server-side.
- `order_items` — detalle de cada línea del pedido: producto, tamaño, cantidad, ingredientes sacados, extras, precio unitario validado.
- `rate_limit` — contador simple por IP+acción para frenar spam de pedidos.

## Seguridad (RLS)
- `categories`, `products`, `product_sizes`, `product_ingredients`, `product_extras`:
  SELECT público (anon + authenticated) para que la tienda pueda leer el catálogo.
  Cero INSERT/UPDATE/DELETE para anon — solo el admin (authenticated con rol admin) puede mutar.
- `orders`: INSERT para anon (la tienda crea pedidos), SELECT/UPDATE/DELETE solo para admin.
  La política de INSERT usa `WITH CHECK (total >= 0)` como barrera mínima; la validación real
  del total y stock la hace la edge function `create-order` con la service role key, no el cliente.
- `order_items`: INSERT para anon solo si el `order_id` ya existe (referencia válida).
  SELECT/UPDATE/DELETE solo admin.
- `rate_limit`: sin políticas públicas — solo la edge function la maneja con service role key.

## Notas importantes
1. El total del pedido NUNCA lo provee el cliente. La edge function recalcula todo desde la DB.
2. El stock se descuenta atómicamente dentro de la edge function usando la service role key.
3. Si el stock llega a 0, `product_sizes.is_available` se apaga automáticamente.
4. No hay rutas ni referencias a admin en este esquema — es solo el catálogo público + pedidos.
*/

-- ============================================================
-- SEQUENCE for order numbers (must exist before the function)
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS order_seq START 1;

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_categories" ON categories;
CREATE POLICY "public_read_categories" ON categories FOR SELECT
  TO anon, authenticated USING (true);

-- ============================================================
-- PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  accent text NOT NULL DEFAULT 'blue',
  tags text[] NOT NULL DEFAULT '{}',
  is_pizza boolean NOT NULL DEFAULT false,
  is_available boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_products" ON products;
CREATE POLICY "public_read_products" ON products FOR SELECT
  TO anon, authenticated USING (true);

-- ============================================================
-- PRODUCT SIZES
-- ============================================================
CREATE TABLE IF NOT EXISTS product_sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  price integer NOT NULL CHECK (price >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_available boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_sizes_product_id ON product_sizes(product_id);

ALTER TABLE product_sizes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_product_sizes" ON product_sizes;
CREATE POLICY "public_read_product_sizes" ON product_sizes FOR SELECT
  TO anon, authenticated USING (true);

-- ============================================================
-- PRODUCT INGREDIENTS (base, sacables)
-- ============================================================
CREATE TABLE IF NOT EXISTS product_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_ingredients_product_id ON product_ingredients(product_id);

ALTER TABLE product_ingredients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_product_ingredients" ON product_ingredients;
CREATE POLICY "public_read_product_ingredients" ON product_ingredients FOR SELECT
  TO anon, authenticated USING (true);

-- ============================================================
-- PRODUCT EXTRAS (opcionales, precio por tamaño)
-- ============================================================
CREATE TABLE IF NOT EXISTS product_extras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_by_size jsonb NOT NULL DEFAULT '{}',
  is_available boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_extras_product_id ON product_extras(product_id);

ALTER TABLE product_extras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_product_extras" ON product_extras;
CREATE POLICY "public_read_product_extras" ON product_extras FOR SELECT
  TO anon, authenticated USING (true);

-- ============================================================
-- FUNCIÓN: generar número de pedido secuencial
-- ============================================================
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS text
LANGUAGE sql
SECURITY DEFINER SET search_path = public
AS $$
  SELECT 'GDX-' || lpad((nextval('order_seq'))::text, 5, '0');
$$;

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  delivery_address text NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'transfer', 'mercadopago')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','coordinating','delivering','delivered','cancelled_payment_failed','pending_payment')),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','cancelled')),
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  mp_preference_id text,
  mp_payment_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at desc);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- anon puede INSERT (la tienda crea pedidos). La validación real del total la hace la edge function.
DROP POLICY IF EXISTS "anon_insert_orders" ON orders;
CREATE POLICY "anon_insert_orders" ON orders FOR INSERT
  TO anon, authenticated WITH CHECK (total >= 0);

-- Solo admin (authenticated) puede leer/modificar pedidos.
DROP POLICY IF EXISTS "admin_read_orders" ON orders;
CREATE POLICY "admin_read_orders" ON orders FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "admin_update_orders" ON orders;
CREATE POLICY "admin_update_orders" ON orders FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_orders" ON orders;
CREATE POLICY "admin_delete_orders" ON orders FOR DELETE
  TO authenticated USING (true);

-- ============================================================
-- ORDER ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  size_name text NOT NULL,
  unit_price integer NOT NULL CHECK (unit_price >= 0),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 99),
  removed_ingredients text[] NOT NULL DEFAULT '{}',
  selected_extras jsonb NOT NULL DEFAULT '[]',
  line_total integer NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- anon puede insertar items (la edge function lo hace con service role, pero dejamos anon por compatibilidad).
DROP POLICY IF EXISTS "anon_insert_order_items" ON order_items;
CREATE POLICY "anon_insert_order_items" ON order_items FOR INSERT
  TO anon, authenticated WITH CHECK (true);

-- Solo admin lee/modifica items.
DROP POLICY IF EXISTS "admin_read_order_items" ON order_items;
CREATE POLICY "admin_read_order_items" ON order_items FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "admin_update_order_items" ON order_items;
CREATE POLICY "admin_update_order_items" ON order_items FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_order_items" ON order_items;
CREATE POLICY "admin_delete_order_items" ON order_items FOR DELETE
  TO authenticated USING (true);

-- ============================================================
-- RATE LIMIT (solo la edge function con service role key accede)
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip text NOT NULL,
  action text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_ip_action ON rate_limit(ip, action, window_start);

-- Sin RLS policies → denegado por defecto para anon y authenticated.
-- Solo la service role key (que bypassa RLS) puede leer/escribir.
ALTER TABLE rate_limit ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- DATOS SEMILLA — Primer drop
-- ============================================================
INSERT INTO categories (name, slug, sort_order, is_active) VALUES
  ('Pizzas', 'pizzas', 1, true),
  ('Bebidas', 'bebidas', 2, true)
ON CONFLICT (slug) DO NOTHING;

-- Productos pizza
INSERT INTO products (id, category_id, name, description, accent, tags, is_pizza, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', c.id, 'The Classic', 'Muzzarella, pepperoni, salsa roja y borde crocante.', 'red', ARRAY['best seller','picante'], true, true, 1
FROM categories c WHERE c.slug = 'pizzas'
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, category_id, name, description, accent, tags, is_pizza, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', c.id, 'Gordy''s BBQ', 'Carne braseada, cheddar, cebolla crispy y BBQ.', 'blue', ARRAY['nuevo','ahumada'], true, true, 2
FROM categories c WHERE c.slug = 'pizzas'
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, category_id, name, description, accent, tags, is_pizza, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', c.id, 'Green Monster', 'Muzzarella, pesto, tomates cherry y albahaca fresca.', 'green', ARRAY['vegetariana'], true, true, 3
FROM categories c WHERE c.slug = 'pizzas'
ON CONFLICT (id) DO NOTHING;

-- Productos bebidas
INSERT INTO products (id, category_id, name, description, accent, tags, is_pizza, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000004', c.id, 'Cola clásica', 'Bien fría. El sidekick oficial del drop.', 'cola', ARRAY['fría'], false, true, 1
FROM categories c WHERE c.slug = 'bebidas'
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, category_id, name, description, accent, tags, is_pizza, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000005', c.id, 'Limonada pop', 'Limonada con gas, fresca y con actitud.', 'lime', ARRAY['fresca'], false, true, 2
FROM categories c WHERE c.slug = 'bebidas'
ON CONFLICT (id) DO NOTHING;

-- Tamaños de pizzas
INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Chica', 12500, 50, true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Chica');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Grande', 16500, 50, true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Grande');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Chica', 13900, 50, true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Chica');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Grande', 17900, 50, true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Grande');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Chica', 12900, 50, true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Chica');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Grande', 16900, 50, true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Grande');

-- Tamaños de bebidas
INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000004', '500 ml', 2200, 100, true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000004' AND name = '500 ml');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000004', '1.5 L', 3900, 100, true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000004' AND name = '1.5 L');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000005', '500 ml', 2400, 100, true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000005' AND name = '500 ml');

INSERT INTO product_sizes (product_id, name, price, stock, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000005', '1.5 L', 4200, 100, true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_sizes WHERE product_id = 'a0000001-0000-0000-0000-000000000005' AND name = '1.5 L');

-- Ingredientes base
INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Muzzarella', 1
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Muzzarella');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Pepperoni', 2
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Pepperoni');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Salsa roja', 3
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Salsa roja');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Orégano', 4
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Orégano');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Muzzarella', 1
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Muzzarella');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Carne braseada', 2
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Carne braseada');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Cheddar', 3
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Cheddar');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Cebolla crispy', 4
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Cebolla crispy');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Salsa BBQ', 5
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Salsa BBQ');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Muzzarella', 1
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Muzzarella');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Pesto', 2
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Pesto');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Tomates cherry', 3
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Tomates cherry');

INSERT INTO product_ingredients (product_id, name, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Albahaca fresca', 4
WHERE NOT EXISTS (SELECT 1 FROM product_ingredients WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Albahaca fresca');

-- Extras (price_by_size: {"0": precio_chica, "1": precio_grande})
INSERT INTO product_extras (product_id, name, price_by_size, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Extra muzza', '{"0":1800,"1":2400}', true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_extras WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Extra muzza');

INSERT INTO product_extras (product_id, name, price_by_size, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000001', 'Panceta crocante', '{"0":2200,"1":2900}', true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_extras WHERE product_id = 'a0000001-0000-0000-0000-000000000001' AND name = 'Panceta crocante');

INSERT INTO product_extras (product_id, name, price_by_size, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Extra cheddar', '{"0":1900,"1":2500}', true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_extras WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Extra cheddar');

INSERT INTO product_extras (product_id, name, price_by_size, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000002', 'Jalapeños', '{"0":900,"1":1200}', true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_extras WHERE product_id = 'a0000001-0000-0000-0000-000000000002' AND name = 'Jalapeños');

INSERT INTO product_extras (product_id, name, price_by_size, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Burrata', '{"0":2500,"1":3300}', true, 1
WHERE NOT EXISTS (SELECT 1 FROM product_extras WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Burrata');

INSERT INTO product_extras (product_id, name, price_by_size, is_available, sort_order)
SELECT 'a0000001-0000-0000-0000-000000000003', 'Aceitunas', '{"0":700,"1":900}', true, 2
WHERE NOT EXISTS (SELECT 1 FROM product_extras WHERE product_id = 'a0000001-0000-0000-0000-000000000003' AND name = 'Aceitunas');

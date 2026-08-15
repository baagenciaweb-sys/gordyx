import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface IncomingItem {
  product_id: string;
  size_id: string;
  quantity: number;
  removed_ingredients: string[];
  selected_extras: { name: string; price: number }[];
}

interface IncomingPayload {
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  payment_method: "cash" | "transfer";
  items: IncomingItem[];
}

const MAX_ORDERS_PER_IP_PER_MINUTE = 5;
const MAX_ITEMS = 30;
const MAX_QTY = 20;

function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.replace(/[<>]/g, "");
}

function sanitizePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^\d+\s()-]/g, "").slice(0, 30);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Rate limiting ---
    const clientIP =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const { data: rlData } = await supabase
      .from("rate_limit")
      .select("id, count, window_start")
      .eq("ip", clientIP)
      .eq("action", "create_order")
      .gte("window_start", oneMinuteAgo)
      .order("window_start", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (rlData && rlData.count >= MAX_ORDERS_PER_IP_PER_MINUTE) {
      return new Response(
        JSON.stringify({ error: "Demasiados pedidos en poco tiempo. Esperá un minuto e intentá de nuevo." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (rlData) {
      await supabase
        .from("rate_limit")
        .update({ count: rlData.count + 1 })
        .eq("id", rlData.id);
    } else {
      await supabase
        .from("rate_limit")
        .insert({ ip: clientIP, action: "create_order", count: 1 });
    }

    // --- Parse & validate input ---
    const body = await req.json() as IncomingPayload;

    const customerName = sanitizeText(body.customer_name, 100);
    const customerPhone = sanitizePhone(body.customer_phone);
    const deliveryAddress = sanitizeText(body.delivery_address, 300);
    const paymentMethod = body.payment_method;

    if (!customerName || !customerPhone || !deliveryAddress) {
      return new Response(JSON.stringify({ error: "Faltan datos del cliente." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (paymentMethod !== "cash" && paymentMethod !== "transfer") {
      return new Response(JSON.stringify({ error: "Método de pago inválido." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
    if (items.length === 0) {
      return new Response(JSON.stringify({ error: "El carrito está vacío." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Fetch all products referenced in the order from DB ---
    const productIds = [...new Set(items.map((i) => i.product_id))];
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select(`
        id, name, is_available, is_pizza,
        product_sizes (id, name, price, stock, is_available, sort_order ),
        product_ingredients ( id, name ),
        product_extras ( id, name, price_by_size, is_available )
      `)
      .in("id", productIds);

    if (productsError || !products) {
      console.error("Error fetching products:", productsError);
      return new Response(JSON.stringify({ error: "No pudimos procesar el pedido. Intentá de nuevo." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    // --- Recalculate every price server-side ---
    let total = 0;
    const validatedItems: Array<{
      product_id: string;
      product_name: string;
      size_name: string;
      unit_price: number;
      quantity: number;
      removed_ingredients: string[];
      selected_extras: { name: string; price: number }[];
      line_total: number;
    }> = [];

    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product || !product.is_available) {
        return new Response(JSON.stringify({ error: "Uno de los productos ya no está disponible." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const sizes = (product.product_sizes as any[])
        .filter((s) => s.is_available)
        .sort((a, b) => a.sort_order - b.sort_order);
      const sizeIndex = sizes.findIndex((s) => s.id === item.size_id);
      if (sizeIndex === -1) {
        return new Response(JSON.stringify({ error: "Tamaño no disponible." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const size = sizes[sizeIndex];
      const qty = Math.max(1, Math.min(Math.floor(item.quantity) || 1, MAX_QTY));

      if (size.stock < qty) {
        return new Response(JSON.stringify({ error: `Sin stock suficiente de ${product.name} (${size.name}).` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Validate removed ingredients
      let removedIngredients: string[] = [];
      if (product.is_pizza && Array.isArray(item.removed_ingredients)) {
        const validIngredientNames = new Set(
          (product.product_ingredients as any[]).map((ing) => ing.name)
        );
        removedIngredients = item.removed_ingredients
          .filter((name) => typeof name === "string" && validIngredientNames.has(name))
          .slice(0, 20);
      }

      // Validate extras and their prices server-side
      let selectedExtras: { name: string; price: number }[] = [];
      if (product.is_pizza && Array.isArray(item.selected_extras)) {
        const validExtras = (product.product_extras as any[]).filter((e) => e.is_available);
        const extraMap = new Map(validExtras.map((e) => [e.name, e]));

        for (const incomingExtra of item.selected_extras) {
          if (typeof incomingExtra.name !== "string") continue;
          const dbExtra = extraMap.get(incomingExtra.name);
          if (!dbExtra) continue;
          const priceBySize = dbExtra.price_by_size as Record<string, number>;
          const serverPrice = priceBySize?.[String(sizeIndex)];
          if (serverPrice === undefined || serverPrice === null) continue;
          selectedExtras.push({ name: dbExtra.name, price: serverPrice });
        }
      }

      const extrasTotal = selectedExtras.reduce((sum, e) => sum + e.price, 0);
      const unitPrice = size.price + extrasTotal;
      const lineTotal = unitPrice * qty;
      total += lineTotal;

      validatedItems.push({
        product_id: product.id,
        product_name: product.name,
        size_name: size.name,
        unit_price: unitPrice,
        quantity: qty,
        removed_ingredients: removedIngredients,
        selected_extras: selectedExtras,
        line_total: lineTotal,
      });

      // Decrement stock atomically
      const newStock = size.stock - qty;
      const { error: stockError } = await supabase
        .from("product_sizes")
        .update({
          stock: newStock,
          is_available: newStock > 0,
        })
        .eq("id", size.id)
        .gte("stock", qty);

      if (stockError) {
        console.error("Stock decrement failed:", stockError);
        return new Response(JSON.stringify({ error: "No pudimos reservar el stock. Intentá de nuevo." }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // --- Generate order number ---
    const { data: orderNumberData } = await supabase
      .rpc("generate_order_number")
      .single();

    const orderNumber = orderNumberData as string;

    // --- Insert order ---
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        order_number: orderNumber,
        customer_name: customerName,
        customer_phone: customerPhone,
        delivery_address: deliveryAddress,
        payment_method: paymentMethod,
        status: paymentMethod === "cash" || paymentMethod === "transfer" ? "pending_payment" : "new",
        payment_status: "pending",
        total,
      })
      .select("id, order_number")
      .single();

    if (orderError || !order) {
      console.error("Order insert failed:", orderError);
      return new Response(JSON.stringify({ error: "No pudimos registrar el pedido. Intentá de nuevo." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Insert order items ---
    const orderItemsRows = validatedItems.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      size_name: item.size_name,
      unit_price: item.unit_price,
      quantity: item.quantity,
      removed_ingredients: item.removed_ingredients,
      selected_extras: JSON.stringify(item.selected_extras),
      line_total: item.line_total,
    }));

    const { error: itemsError } = await supabase
      .from("order_items")
      .insert(orderItemsRows);

    if (itemsError) {
      console.error("Order items insert failed:", itemsError);
      return new Response(JSON.stringify({ error: "No pudimos registrar el pedido. Intentá de nuevo." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        order_number: order.order_number,
        total,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("create-order error:", err);
    return new Response(
      JSON.stringify({ error: "Ocurrió un error inesperado. Intentá de nuevo." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

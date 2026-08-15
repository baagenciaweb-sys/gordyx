import { supabase } from "./supabase";
import type { Category, Product } from "./types";

export async function fetchCatalog(): Promise<{ categories: Category[]; products: Product[] }> {
  const [{ data: categories }, { data: products }] = await Promise.all([
    supabase
      .from("categories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("products")
      .select(`
        *,
        sizes: product_sizes (*),
        ingredients: product_ingredients (*),
        extras: product_extras (*),
        category: categories (*)
      `)
      .eq("is_available", true)
      .order("sort_order"),
  ]);

  const sortedProducts = (products || []).map((p: any) => ({
    ...p,
    sizes: (p.sizes || []).filter((s: any) => s.is_available).sort((a: any, b: any) => a.sort_order - b.sort_order),
    ingredients: (p.ingredients || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    extras: (p.extras || []).filter((e: any) => e.is_available).sort((a: any, b: any) => a.sort_order - b.sort_order),
  }));

  return { categories: categories || [], products: sortedProducts };
}

export async function submitOrder(payload: {
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  payment_method: "cash" | "transfer";
  items: {
    product_id: string;
    size_id: string;
    quantity: number;
    removed_ingredients: string[];
    selected_extras: { name: string; price: number }[];
  }[];
}): Promise<{ success: boolean; order_number?: string; total?: number; error?: string }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-order`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    return { success: false, error: data.error || "No pudimos procesar el pedido. Intentá de nuevo." };
  }

  return { success: true, order_number: data.order_number, total: data.total };
}

export type Category = {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
  is_active: boolean;
};

export type ProductSize = {
  id: string;
  product_id: string;
  name: string;
  price: number;
  stock: number;
  is_available: boolean;
  sort_order: number;
};

export type ProductIngredient = {
  id: string;
  product_id: string;
  name: string;
  sort_order: number;
};

export type ProductExtra = {
  id: string;
  product_id: string;
  name: string;
  price_by_size: Record<string, number>;
  is_available: boolean;
  sort_order: number;
};

export type Product = {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  accent: string;
  tags: string[];
  is_pizza: boolean;
  is_available: boolean;
  sort_order: number;
  sizes: ProductSize[];
  ingredients: ProductIngredient[];
  extras: ProductExtra[];
  category?: Category;
};

export type CartItem = {
  key: string;
  product: Product;
  sizeId: string;
  sizeIndex: number;
  removed: string[];
  extras: { name: string; price: number }[];
  quantity: number;
};

export type OrderPayload = {
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
};

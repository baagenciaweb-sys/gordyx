import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Clock3, Minus, Plus, ShoppingBag, Sparkles, Truck, X, Zap } from 'lucide-react';
import { fetchCatalog, submitOrder } from '@/lib/api';
import type { CartItem, Category, Product } from '@/lib/types';
import IntroSplash from './IntroSplash';

const money = (value: number) => `$${value.toLocaleString('es-AR')}`;

const isOpen = () => {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  return day >= 3 && day <= 6 && hour >= 20 && hour < 24;
};

function App() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [category, setCategory] = useState<'Todos' | string>('Todos');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [orderResult, setOrderResult] = useState<{ number: string; total: number } | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sizeId, setSizeId] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  const [extras, setExtras] = useState<{ name: string; price: number }[]>([]);
  const [payment, setPayment] = useState<'cash' | 'transfer'>('cash');
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(isOpen());
  const [introDone, setIntroDone] = useState(() => sessionStorage.getItem('gordyx-intro-seen') === '1');

  useEffect(() => {
    const load = async () => {
      const { categories, products } = await fetchCatalog();
      setCategories(categories);
      setProducts(products);
      setLoading(false);
    };
    load().catch(() => { setLoadError(true); setLoading(false); });
    const interval = setInterval(() => setOpen(isOpen()), 30000);
    return () => clearInterval(interval);
  }, []);

  const filtered = category === 'Todos' ? products : products.filter((p) => p.category?.name === category);
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => {
    const size = item.product.sizes.find((s) => s.id === item.sizeId);
    if (!size) return sum;
    const extrasTotal = item.extras.reduce((extraSum, e) => extraSum + e.price, 0);
    return sum + (size.price + extrasTotal) * item.quantity;
  }, 0);
  const grouped = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cat of categories) counts[cat.name] = products.filter((p) => p.category?.name === cat.name).length;
    return counts;
  }, [categories, products]);

  const openProduct = (product: Product) => {
    setSelected(product);
    setSizeId(product.sizes[0]?.id || '');
    setRemoved([]);
    setExtras([]);
  };

  const addToCart = () => {
    if (!selected || !sizeId) return;
    const sizeIndex = selected.sizes.findIndex((s) => s.id === sizeId);
    if (sizeIndex === -1) return;
    const removedKey = removed.sort().join(',');
    const extrasKey = extras.map((e) => e.name).sort().join(',');
    const key = `${selected.id}-${sizeId}-${removedKey}-${extrasKey}`;
    setCart((current) => {
      const existing = current.find((item) => item.key === key);
      if (existing) return current.map((item) => item.key === key ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { key, product: selected, sizeId, sizeIndex, removed, extras, quantity: 1 }];
    });
    setSelected(null);
    setDrawer(true);
  };

  const changeQuantity = (key: string, delta: number) => setCart((current) => current.flatMap((item) => item.key === key ? (item.quantity + delta > 0 ? [{ ...item, quantity: item.quantity + delta }] : []) : [item]));
  const scrollToDrop = () => document.getElementById('drop')?.scrollIntoView({ behavior: 'smooth' });

  const handleConfirm = async (name: string, phone: string, address: string) => {
    setSubmitting(true);
    setOrderError(null);
    const result = await submitOrder({
      customer_name: name,
      customer_phone: phone,
      delivery_address: address,
      payment_method: payment,
      items: cart.map((item) => ({
        product_id: item.product.id,
        size_id: item.sizeId,
        quantity: item.quantity,
        removed_ingredients: item.removed,
        selected_extras: item.extras,
      })),
    });
    setSubmitting(false);
    if (result.success && result.order_number) {
      setCheckout(false);
      setCart([]);
      setOrderResult({ number: result.order_number, total: result.total || total });
    } else {
      setOrderError(result.error || 'No pudimos procesar el pedido.');
    }
  };

  return (
    <div className="site-shell">
      {!introDone && <IntroSplash onDone={() => { sessionStorage.setItem('gordyx-intro-seen', '1'); setIntroDone(true); }} />}
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Gordyx inicio"><img src="/11.png" alt="Gordyx" /></a>
        <div className="status-pill"><span className={open ? 'status-dot open' : 'status-dot'} /> {open ? 'Estamos prendidos' : 'Abrimos mié—dom · 20 a 00h'}</div>
        <button className="cart-button" onClick={() => setDrawer(true)} aria-label="Abrir carrito"><ShoppingBag size={20} /><span>{itemCount}</span></button>
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-glow glow-one" /><div className="hero-glow glow-two" />
          <div className="hero-copy">
            <p className="eyebrow"><Zap size={14} fill="currentColor" /> Primer drop · Olavarría</p>
            <h1 className="hero-logo-title"><img className="hero-foodfor" src="/svg/gordyx-foodfor.svg" alt="" aria-hidden="true" /><img src="/Ilustración_sin_título_(2) copy.png" alt="GORDYX" /></h1>
            <p className="hero-text">Detroit-style pizza, bebidas frías y cero ganas de comer aburrido.</p>
            <div className="hero-actions"><button className="primary-button" onClick={scrollToDrop}>Ver catálogo <ArrowRight size={18} /></button><span className="delivery-note"><Truck size={16} /> Delivery gratis en Olavarría</span></div>
          </div>
          <div className="hero-art"><img className="hero-art-bg" src="/333.png" alt="" aria-hidden="true" /><img className="hero-art-lines" src="/32222_(5).png" alt="Mascota de GORDYX" /><div className="burst">NEW<br />DROP</div></div>
          <div className="hero-sticker sticker-right">EST. 2024</div>
        </section>

        <section className="marquee"><div>DETROIT PIZZA <span>✦</span> BEBIDAS FRÍAS <span>✦</span> FOOD FOR GORDYX <span>✦</span> DELIVERY GRATIS <span>✦</span></div></section>

        <section className="drop-section" id="drop">
          <div className="section-heading"><div><p className="eyebrow blue-label">El menú</p><h2>Elegí tu <em>mood.</em></h2></div><p className="section-intro">Masa alta, bordes caramelizados<br />y toppings que no piden permiso.</p></div>
          {loading ? <div className="loading-state"><div className="spinner" /><p>Cargando el drop…</p></div>
           : loadError ? <div className="loading-state"><p>No pudimos cargar el menú. Recargá la página.</p></div>
           : <>
            <div className="category-tabs">
              <button className={category === 'Todos' ? 'active' : ''} onClick={() => setCategory('Todos')}>Todo el drop <small>{products.length}</small></button>
              {categories.map((cat) => <button key={cat.id} className={category === cat.name ? 'active' : ''} onClick={() => setCategory(cat.name)}>{cat.name} <small>{grouped[cat.name] || 0}</small></button>)}
            </div>
            <div className="product-grid">{filtered.map((product, index) => <ProductCard key={product.id} product={product} index={index} onClick={() => openProduct(product)} />)}</div>
          </>}
        </section>

        <section className="delivery-band"><div className="delivery-icon"><Truck size={27} /></div><div><p className="eyebrow">No hacemos esperar</p><h3>Te lo mandamos a todo Olavarría.</h3></div><p>Envío gratis, sin pedido mínimo.<br />Coordinamos por WhatsApp.</p></section>
        <section className="manifesto"><p className="eyebrow">La crew</p><h2>Comida con<br /><span>colmillo.</span></h2><p>Gordyx es el lugar para cuando querés algo distinto. Sin vueltas, con mucho queso y esa energía de salir a la calle con hambre.</p></section>
      </main>

      <footer><div className="footer-brand"><img src="/11.png" alt="Gordyx" /><p>Food for Gordyx.</p></div><div><p className="footer-label">Horario</p><p>Miércoles a domingo<br />20:00 a 00:00 hs</p></div><div><p className="footer-label">Delivery</p><p>Olavarría, Buenos Aires<br />Gratis · sin mínimo</p></div><div><p className="footer-label">Contacto</p><p>Te hablamos por WhatsApp<br />cuando entra tu pedido.</p></div><div className="copyright">© 2024 GORDYX</div></footer>

      {selected && <ProductModal product={selected} sizeId={sizeId} setSizeId={setSizeId} removed={removed} setRemoved={setRemoved} extras={extras} setExtras={setExtras} onClose={() => setSelected(null)} onAdd={addToCart} />}
      {drawer && <CartDrawer cart={cart} total={total} onClose={() => setDrawer(false)} onChange={changeQuantity} onCheckout={() => { setDrawer(false); setCheckout(true); }} />}
      {checkout && <CheckoutModal cart={cart} total={total} open={open} payment={payment} setPayment={setPayment} submitting={submitting} orderError={orderError} onClose={() => setCheckout(false)} onConfirm={handleConfirm} />}
      {orderResult && <div className="success-overlay"><div className="success-card"><div className="success-mark"><Check size={32} /></div><p className="eyebrow blue-label">Pedido recibido</p><h2>Ya está en la cocina.</h2><p>Te vamos a contactar por WhatsApp para coordinar la entrega en Olavarría.</p><strong>Pedido #{orderResult.number}</strong><p className="order-total-line">Total: <strong>{money(orderResult.total)}</strong></p><button className="primary-button" onClick={() => setOrderResult(null)}>Volver al menú <ArrowRight size={18} /></button></div></div>}
    </div>
  );
}

function ProductCard({ product, index, onClick }: { product: Product; index: number; onClick: () => void }) {
  const minPrice = product.sizes.length > 0 ? Math.min(...product.sizes.map((s) => s.price)) : 0;
  return <article className={`product-card card-${product.accent}`} style={{ animationDelay: `${index * 70}ms` }}><div className="card-visual"><div className="visual-shape" /><span className="card-category">{product.category?.name}</span><span className="visual-word">{product.is_pizza ? 'DETROIT' : 'CHILL'}</span><div className="visual-badge">{product.is_pizza ? '8x8' : 'ICE'}</div></div><div className="card-content"><div className="tag-row">{(product.tags || []).map((tag) => <span key={tag}>{tag}</span>)}</div><h3>{product.name}</h3><p>{product.description}</p><div className="card-bottom"><div><small>Desde</small><strong>{money(minPrice)}</strong></div><button className="round-add" onClick={onClick} aria-label={`Personalizar ${product.name}`}><Plus size={22} /></button></div></div></article>;
}

function ProductModal({ product, sizeId, setSizeId, removed, setRemoved, extras, setExtras, onClose, onAdd }: { product: Product; sizeId: string; setSizeId: (v: string) => void; removed: string[]; setRemoved: (v: string[]) => void; extras: { name: string; price: number }[]; setExtras: (v: { name: string; price: number }[]) => void; onClose: () => void; onAdd: () => void }) {
  const sizeIndex = product.sizes.findIndex((s) => s.id === sizeId);
  const safeSizeIndex = sizeIndex >= 0 ? sizeIndex : 0;
  const size = product.sizes[safeSizeIndex];
  const extrasPrice = extras.reduce((sum, e) => sum + e.price, 0);
  const finalPrice = (size?.price || 0) + extrasPrice;

  const toggleRemoved = (name: string) => setRemoved(removed.includes(name) ? removed.filter((i) => i !== name) : [...removed, name]);
  const toggleExtra = (extra: typeof product.extras[number]) => {
    const existing = extras.find((e) => e.name === extra.name);
    if (existing) setExtras(extras.filter((e) => e.name !== extra.name));
    else {
      const price = extra.price_by_size[String(safeSizeIndex)] ?? 0;
      setExtras([...extras, { name: extra.name, price }]);
    }
  };

  return <div className="modal-backdrop"><div className="product-modal"><button className="close-button" onClick={onClose}><X size={20} /></button><div className={`modal-art card-${product.accent}`}><span>{product.is_pizza ? 'DETROIT' : 'CHILL'}</span><strong>{product.name}</strong></div><div className="modal-details"><p className="eyebrow blue-label">Personalizá tu pedido</p><h2>{product.name}</h2><p className="muted">{product.description}</p><label className="field-label">Elegí tu tamaño</label><div className="size-options">{product.sizes.map((s) => <button key={s.id} className={sizeId === s.id ? 'selected' : ''} onClick={() => { setSizeId(s.id); setExtras([]); }}><span>{s.name}</span><strong>{money(s.price)}</strong></button>)}</div>{product.is_pizza && product.ingredients.length > 0 && <><label className="field-label">Ingredientes base <small>Podés sacar lo que quieras</small></label><div className="check-list">{product.ingredients.map((ing) => <button key={ing.id} className={removed.includes(ing.name) ? 'checked' : ''} onClick={() => toggleRemoved(ing.name)}><span className="check-box">{removed.includes(ing.name) && <Check size={13} />}</span>{removed.includes(ing.name) ? `Sin ${ing.name.toLowerCase()}` : ing.name}</button>)}</div></>}{product.is_pizza && product.extras.length > 0 && <><label className="field-label">Extras <small>Sumalos a tu manera</small></label><div className="extra-list">{product.extras.map((extra) => { const price = extra.price_by_size[String(safeSizeIndex)] ?? 0; const isSelected = extras.some((e) => e.name === extra.name); return <button key={extra.id} className={isSelected ? 'selected' : ''} onClick={() => toggleExtra(extra)}><span>{extra.name}</span><strong>+{money(price)}</strong></button>; })}</div></>}<div className="modal-footer"><strong>{money(finalPrice)}</strong><button className="primary-button" onClick={onAdd}>Agregar al carrito <Plus size={18} /></button></div></div></div></div>;
}

function CartDrawer({ cart, total, onClose, onChange, onCheckout }: { cart: CartItem[]; total: number; onClose: () => void; onChange: (key: string, delta: number) => void; onCheckout: () => void }) {
  return <div className="drawer-backdrop" onClick={onClose}><aside className="cart-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><p className="eyebrow blue-label">Tu pedido</p><h2>La bolsa.</h2></div><button className="close-button" onClick={onClose}><X size={20} /></button></div>{cart.length === 0 ? <div className="empty-cart"><ShoppingBag size={38} /><p>Tu bolsa está esperando<br />algo rico.</p><button className="text-button" onClick={onClose}>Ver el menú <ArrowRight size={16} /></button></div> : <><div className="cart-items">{cart.map((item) => { const size = item.product.sizes.find((s) => s.id === item.sizeId); const unitPrice = (size?.price || 0) + item.extras.reduce((s, e) => s + e.price, 0); return <div className="cart-item" key={item.key}><div className={`mini-art card-${item.product.accent}`}>{item.product.is_pizza ? 'PZ' : 'DR'}</div><div className="cart-item-info"><strong>{item.product.name}</strong><span>{size?.name}{item.extras.length ? ` · +${item.extras.map((e) => e.name).join(', ')}` : ''}</span>{item.removed.length > 0 && <small>Sin {item.removed.join(', ')}</small>}<div className="quantity"><button onClick={() => onChange(item.key, -1)}><Minus size={13} /></button><span>{item.quantity}</span><button onClick={() => onChange(item.key, 1)}><Plus size={13} /></button></div></div><strong className="item-price">{money(unitPrice * item.quantity)}</strong></div>; })}</div><div className="cart-summary"><div><span>Subtotal</span><strong>{money(total)}</strong></div><div className="free-delivery"><Truck size={16} /><span>Envío gratis a todo Olavarría</span></div><button className="primary-button full-button" onClick={onCheckout}>Continuar al checkout <ArrowRight size={18} /></button><small className="checkout-note">Solo delivery · No hay pedido mínimo</small></div></>}</aside></div>;
}

function CheckoutModal({ cart, total, open, payment, setPayment, submitting, orderError, onClose, onConfirm }: { cart: CartItem[]; total: number; open: boolean; payment: 'cash' | 'transfer'; setPayment: (v: 'cash' | 'transfer') => void; submitting: boolean; orderError: string | null; onClose: () => void; onConfirm: (name: string, phone: string, address: string) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const canConfirm = name.trim() && phone.trim() && address.trim() && cart.length > 0 && !submitting;

  return <div className="modal-backdrop"><div className="checkout-modal"><button className="close-button" onClick={onClose}><X size={20} /></button><div className="checkout-heading"><p className="eyebrow blue-label">Último paso</p><h2>Coordinemos<br /><em>el delivery.</em></h2><p>Entregamos en toda la ciudad de Olavarría, sin retiro en local.</p></div>
  {!open && <div className="closed-warning"><Clock3 size={16} /> <span>Cerrado ahora — abrimos miércoles a domingo de 20 a 00hs. Podés armar tu pedido pero lo confirmamos cuando abramos.</span></div>}
  <div className="checkout-layout"><div className="checkout-form"><label>Nombre y apellido<input value={name} onChange={(event) => setName(event.target.value)} placeholder="¿Cómo te llamás?" maxLength={100} /></label><label>WhatsApp<input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Ej. 2284 555 555" maxLength={30} /></label><label>Dirección de entrega<input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Calle, número y referencia" maxLength={300} /></label><label className="field-label">¿Cómo pagás?</label><div className="payment-options"><button className={payment === 'cash' ? 'selected' : ''} onClick={() => setPayment('cash')}><span>💵</span><div><strong>Efectivo</strong><small>Al recibir tu pedido</small></div><Check size={17} /></button><button className={payment === 'transfer' ? 'selected' : ''} onClick={() => setPayment('transfer')}><span>↗</span><div><strong>Transferencia</strong><small>Te pasamos los datos por WhatsApp</small></div><Check size={17} /></button></div><p className="no-cancel"><Sparkles size={14} /> Al confirmar, tu pedido pasa a preparación y no puede cancelarse.</p></div><div className="order-resume"><p className="field-label">Resumen</p>{cart.map((item) => { const size = item.product.sizes.find((s) => s.id === item.sizeId); const unitPrice = (size?.price || 0) + item.extras.reduce((s, e) => s + e.price, 0); return <div className="resume-item" key={item.key}><span>{item.quantity}× {item.product.name}<small>{size?.name}{item.extras.length ? ` · +${item.extras.map((e) => e.name).join(', ')}` : ''}{item.removed.length ? ` · sin ${item.removed.join(', ')}` : ''}</small></span><strong>{money(unitPrice * item.quantity)}</strong></div>; })}<div className="resume-total"><span>Total</span><strong>{money(total)}</strong></div>{orderError && <p className="order-error">{orderError}</p>}<button className="primary-button full-button" disabled={!canConfirm} onClick={() => onConfirm(name, phone, address)}>{submitting ? 'Confirmando…' : 'Confirmar pedido'} <ArrowRight size={18} /></button></div></div></div></div>;
}

export default App;

const STATES = ['pendiente','aceptado','listo','transito','llegado','completo','incompleto'];
const LOCALS = ['Maldonado','Minas','Punta del Este','Montevideo','Rocha','San Carlos'];
const PRODUCTS = Array.from({length: 800}, (_, i) => ({
  codigo: String(100000 + i),
  nombre: `Producto ${i + 1}`,
  marca: `Marca ${i % 25}`
}));

function makeOrders(count) {
  return Array.from({length: count}, (_, i) => {
    const destino = LOCALS[i % LOCALS.length];
    const origen = LOCALS[(i + 2) % LOCALS.length];
    const itemCount = 1 + (i % 8);
    return {
      id: `order-${i}`,
      estado: STATES[i % STATES.length],
      origen_local: origen,
      destino_local: destino,
      created_at: new Date(Date.now() - (i % 120) * 3600000).toISOString(),
      updated_at: new Date().toISOString(),
      pedido_productos: Array.from({length: itemCount}, (_, j) => {
        const p = PRODUCTS[(i * 7 + j) % PRODUCTS.length];
        return {...p, cantidad: 1 + ((i + j) % 12)};
      })
    };
  });
}

function analyze(orders) {
  const products = new Map();
  let units = 0;
  for (const order of orders) {
    for (const item of order.pedido_productos || []) {
      const qty = Number(item.cantidad) || 0;
      units += qty;
      const key = item.codigo || item.nombre;
      const row = products.get(key) || {nombre: item.nombre, units: 0, orders: 0};
      row.units += qty;
      row.orders += 1;
      products.set(key, row);
    }
  }
  return {
    orders: orders.length,
    units,
    products: products.size,
    top: Array.from(products.values()).sort((a, b) => b.units - a.units).slice(0, 10)
  };
}

const count = Number(process.argv[2] || 50000);
const start = performance.now();
const orders = makeOrders(count);
const generatedAt = performance.now();
const result = analyze(orders);
const end = performance.now();

console.log(JSON.stringify({
  generated_orders: result.orders,
  generated_products: result.products,
  total_units: result.units,
  generation_ms: Math.round(generatedAt - start),
  analysis_ms: Math.round(end - generatedAt),
  total_ms: Math.round(end - start),
  top_3: result.top.slice(0, 3)
}, null, 2));

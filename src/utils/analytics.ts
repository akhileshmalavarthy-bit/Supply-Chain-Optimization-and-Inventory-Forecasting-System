import {
  Product,
  InventoryTransaction,
  PurchaseOrder,
  Supplier,
  CalculatedProductAnalytics,
  SupplierPerformanceMetrics,
} from '../types';

export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

export function formatDate(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function addDays(dateStrOrObj: string | Date, n: number): Date {
  const x = typeof dateStrOrObj === 'string' ? new Date(dateStrOrObj + 'T00:00:00') : new Date(dateStrOrObj);
  x.setDate(x.getDate() + n);
  return x;
}

export function formatCurrency(amount: number, symbol = '₹', locale = 'en-IN'): string {
  return `${symbol}${Math.round(amount).toLocaleString(locale)}`;
}

/**
 * Ledger formula from specification:
 * Current Stock = Opening Stock + IN - OUT + adjustments
 * (OUT is stored as negative quantity and each adjustment as signed quantity)
 */
export function getStock(product: Product, transactions: InventoryTransaction[]): number {
  const txSum = sum(
    transactions
      .filter((t) => t.pid === product.id)
      .map((t) => t.qty)
  );
  return product.opening + txSum;
}

export function getAverageDemand(
  productId: number,
  demandMap: Record<number, number[]>,
  windowDays: number
): number {
  const series = demandMap[productId] || [];
  if (series.length === 0) return 0;
  const slice = series.slice(-windowDays);
  return sum(slice) / slice.length;
}

export function getStockStatus(
  product: Product,
  transactions: InventoryTransaction[]
): [label: string, badgeColor: 'r' | 'o' | 'g', code: 'out' | 'low' | 'ok'] {
  const s = getStock(product, transactions);
  if (s <= 0) return ['Out of Stock', 'r', 'out'];
  if (s <= product.rop) return ['Low Stock', 'o', 'low'];
  return ['Healthy Stock', 'g', 'ok'];
}

export function getIncomingStock(
  product: Product,
  purchaseOrders: PurchaseOrder[],
  todayStr: string
): number {
  const limitDate = formatDate(addDays(todayStr, product.lead));
  return sum(
    purchaseOrders
      .filter((po) => po.pid === product.id && po.st === 'pending' && po.ex <= limitDate)
      .map((po) => po.qty)
  );
}

export function calculateProductAnalytics(
  product: Product,
  transactions: InventoryTransaction[],
  purchaseOrders: PurchaseOrder[],
  demandMap: Record<number, number[]>,
  todayStr: string,
  windowDays = 30,
  excessThresholdDays = 60
): CalculatedProductAnalytics {
  const s = getStock(product, transactions);
  const a = getAverageDemand(product.id, demandMap, windowDays);
  const ld = a * product.lead;
  const rop = Math.round(ld + product.safety);
  const inc = getIncomingStock(product, purchaseOrders, todayStr);
  const av = s + inc;
  const days = a > 0 ? s / a : Infinity;

  const baseDesc = `${a.toFixed(1)}/day × ${product.lead} days = ${Math.round(ld)} units needed in lead time`;

  let risk: [string, 'r' | 'o' | 'g' | 'b'];
  let f: string;
  let why: string;
  let act: string;

  if (s <= 0) {
    risk = ['Out of stock (actual)', 'r'];
    f = 'reorder stockout';
    why = `Current stock is 0. ${inc ? `${inc} units pending within lead time.` : 'No reliable incoming stock.'}`;
    act = 'Review urgent reorder';
  } else if (av < ld) {
    risk = ['Potential stockout', 'r'];
    f = 'reorder stockout';
    why = `Available ${av} (stock ${s} + incoming ${inc}) is below ${baseDesc}.`;
    act = 'Review reorder now';
  } else if (s <= rop) {
    risk = ['Reorder required', 'o'];
    f = 'reorder';
    why = `Stock ${s} ≤ ROP ${rop} (${baseDesc} + safety ${product.safety}).`;
    act = 'Plan a purchase order';
  } else if (a > 0 && days > excessThresholdDays) {
    risk = ['Potential excess', 'b'];
    f = 'excess';
    why = `${days.toFixed(0)} days of stock exceeds the ${excessThresholdDays}-day threshold.`;
    act = 'Pause reordering';
  } else {
    risk = ['Healthy', 'g'];
    f = 'ok';
    why = `Stock ${s} is above ROP ${rop}${a > 0 ? ` with ${days.toFixed(0)} days of cover.` : ' (no recent demand).'}`;
    act = 'No action';
  }

  return {
    p: product,
    s,
    a,
    ld,
    rop,
    inc,
    av,
    days,
    risk,
    f,
    why,
    act,
  };
}

export function calculateSupplierMetrics(
  supplier: Supplier,
  purchaseOrders: PurchaseOrder[]
): SupplierPerformanceMetrics {
  const orders = purchaseOrders.filter((x) => x.sup === supplier.id);
  const received = orders.filter((x) => x.st === 'received' && x.rc);
  const delays = received.map((x) => {
    const rcTime = new Date(x.rc! + 'T00:00:00').getTime();
    const exTime = new Date(x.ex + 'T00:00:00').getTime();
    return (rcTime - exTime) / 86400000;
  });

  const onTimeCount = delays.filter((d) => d <= 0).length;

  return {
    supplier,
    total: orders.length,
    done: received.length,
    ont: received.length ? Math.round((100 * onTimeCount) / received.length) : null,
    delay: received.length ? sum(delays) / received.length : null,
    dl: delays,
  };
}

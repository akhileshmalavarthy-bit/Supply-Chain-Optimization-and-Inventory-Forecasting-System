import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
  runTransaction,
  Timestamp,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  Tenant,
  TenantDataState,
  Product,
  InventoryRecord,
  Supplier,
  InventoryTransaction,
  PurchaseOrder,
  ForecastRecord,
  NotificationRecord,
  ReportRecord,
  AuditLogEntry,
  UserRole,
  StockStatusLabel,
  StockMovementType,
} from '../types';
import { sum, computeStockStatusLabel } from '../utils/analytics';

// In-flight transaction lock to prevent duplicate concurrent submissions
const inFlightTxLocks = new Set<string>();

function formatTimestamp(val: unknown, fallback = new Date().toISOString()): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string' && val.length > 0) {
    return val;
  }
  return fallback;
}

export function formatProductId(id: number, customProductId?: string): string {
  const clean = (customProductId || '').trim();
  if (clean && /^[a-zA-Z0-9_-]{3,64}$/.test(clean) && !/^\d+$/.test(clean)) {
    return clean;
  }
  return `PROD${String(Math.max(1, Number(id) || 1)).padStart(3, '0')}`;
}

function defaultCategoryForSku(sku: string, name: string): string {
  const s = (sku + ' ' + name).toUpperCase();
  if (s.includes('LAP') || s.includes('MON') || s.includes('PRN')) return 'Computing & Displays';
  if (s.includes('MOU') || s.includes('KEY') || s.includes('WEB') || s.includes('HDP'))
    return 'Peripherals & Audio';
  if (s.includes('HDD')) return 'Storage Media';
  if (s.includes('CBL') || s.includes('RTR')) return 'Networking & Cabling';
  return 'General Electronics';
}

function defaultWarehouseForProduct(productId: number, tenantId: string): string {
  const code = tenantId.includes('eu')
    ? 'WH-FRA'
    : tenantId.includes('us')
    ? 'WH-PDX'
    : 'WH-BLR';
  return `${code}-A${((productId - 1) % 4) + 1}`;
}

function defaultSupplierMeta(s: Supplier, index: number) {
  const contacts = [
    ['Rajesh Iyer', 'orders@techsource.in', '+91-80-4112-8801', 'Electronic City Phase 1, Bengaluru'],
    ['Meera Nair', 'supply@accessoryworld.in', '+91-22-2650-4412', 'Andheri East, Mumbai'],
    ['Vikram Malhotra', 'dispatch@storagehub.io', '+91-40-6611-9023', 'HITEC City, Hyderabad'],
    ['Ananya Sen', 'logistics@audiovision.in', '+91-44-2815-7734', 'Guindy Industrial Estate, Chennai'],
    ['Karthik Reddy', 'ops@netlinkdist.in', '+91-80-2290-3345', 'Whitefield Main Rd, Bengaluru'],
  ];
  const fallback = contacts[index % contacts.length];
  return {
    contactPerson: (s.contactPerson || fallback[0]).slice(0, 60),
    email: (s.email || fallback[1]).slice(0, 100),
    phone: (s.phone || fallback[2]).slice(0, 30),
    address: (s.address || fallback[3]).slice(0, 150),
    status: (s.status || 'ACTIVE') as 'ACTIVE' | 'ON_HOLD' | 'INACTIVE',
  };
}

export async function ensureUserProfileInFirestore(
  uid: string,
  name: string,
  email: string,
  role: UserRole,
  activeTenantId: string
): Promise<{ role: UserRole; activeTenantId: string }> {
  const userPath = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const snap = await getDoc(userRef);
    const cleanEmail = (email || 'authenticated@supplychain.io').slice(0, 120);
    if (!snap.exists()) {
      const initialRole: UserRole =
        cleanEmail === 'akhileshmalavarthy@gmail.com' ? 'SUPER_ADMIN' : 'INVENTORY_ANALYST';
      await setDoc(userRef, {
        uid: uid.slice(0, 128),
        name: (name || 'Workspace User').slice(0, 80),
        email: cleanEmail,
        role: initialRole,
        activeTenantId: activeTenantId.slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return { role: initialRole, activeTenantId };
    } else {
      const data = snap.data();
      return {
        role: (data.role as UserRole) || role,
        activeTenantId: String(data.activeTenantId || activeTenantId),
      };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function updateUserRoleInFirestore(
  uid: string,
  name: string,
  email: string,
  newRole: UserRole,
  activeTenantId: string
): Promise<void> {
  const userPath = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await ensureUserProfileInFirestore(uid, name, email, newRole, activeTenantId);
      return;
    }
    await updateDoc(userRef, {
      role: newRole,
      activeTenantId: activeTenantId.slice(0, 64),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, userPath);
  }
}

/**
 * Ensures the tenant workspace exists in Firestore.
 * IMPORTANT: Never silently overwrites existing tenant records if the tenant document
 * or any subcollection records already exist. Initial seed records are explicitly
 * marked with `isSample: true`. If existing product documents were created under an older
 * schema without `productId`/`stockStatus`, upgrades them in-place while preserving values.
 */
export async function ensureTenantSeededInFirestore(
  uid: string,
  userEmail: string,
  seedState: TenantDataState,
  forceReseedSample = false
): Promise<void> {
  const tenantId = seedState.tenant.id;
  const tenantPath = `tenants/${tenantId}`;
  try {
    const tenantRef = doc(db, 'tenants', tenantId);
    const snap = await getDoc(tenantRef);

    // Check top-level `products` collection for this tenant
    const topLevelProductsSnap = await getDocs(
      query(collection(db, 'products'), where('tenantId', '==', tenantId))
    );

    if (snap.exists() && !topLevelProductsSnap.empty && !forceReseedSample) {
      const existingSuppliersSnap = await getDocs(
        query(collection(db, 'tenants', tenantId, 'suppliers'), where('tenantId', '==', tenantId))
      );
      if (existingSuppliersSnap.empty) {
        await seedMissingCollectionsOnly(tenantId, seedState);
      }
      return;
    }

    // If tenant exists and top-level `products` is empty, check if products exist in legacy subcollection and migrate them to top-level `products`
    if (snap.exists() && topLevelProductsSnap.empty && !forceReseedSample) {
      const legacySubProductsSnap = await getDocs(
        query(collection(db, 'tenants', tenantId, 'products'), where('tenantId', '==', tenantId))
      );
      if (!legacySubProductsSnap.empty) {
        await migrateToTopLevelProductsCollection(tenantId, legacySubProductsSnap.docs);
        return;
      }
    }

    if (!snap.exists()) {
      await setDoc(tenantRef, {
        id: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        name: seedState.tenant.name.slice(0, 80),
        code: seedState.tenant.code.slice(0, 20),
        region: seedState.tenant.region.slice(0, 60),
        currencySymbol: seedState.tenant.currencySymbol.slice(0, 5),
        currencyLocale: seedState.tenant.currencyLocale.slice(0, 16),
        status: seedState.tenant.status || 'ACTIVE',
        today: seedState.today.slice(0, 10),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    await writeSampleTenantRecords(uid, userEmail, seedState);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, tenantPath);
  }
}

async function migrateToTopLevelProductsCollection(
  tenantId: string,
  productDocs: { id: string; data: () => Record<string, unknown> }[]
): Promise<void> {
  const txSnap = await getDocs(
    query(
      collection(db, 'tenants', tenantId, 'inventoryTransactions'),
      where('tenantId', '==', tenantId)
    )
  );
  const txs = txSnap.docs.map((d) => d.data());
  const batch = writeBatch(db);

  for (const pDoc of productDocs) {
    const data = pDoc.data();
    const pid = Number(data.id);
    const docId = formatProductId(pid, String(data.productId || ''));
    const opening = Math.max(0, Number(data.opening || 0));
    const txDelta = sum(
      txs.filter((t) => Number(t.pid) === pid).map((t) => Number(t.qty || 0))
    );
    const currentStock =
      data.currentStock !== undefined
        ? Math.max(0, Number(data.currentStock))
        : Math.max(0, opening + txDelta);
    const lowStockThreshold = Math.max(
      0,
      Number(data.lowStockThreshold !== undefined ? data.lowStockThreshold : data.rop || 0)
    );
    const stockStatus = computeStockStatusLabel(currentStock, lowStockThreshold);
    const cost = Math.max(0, Number(data.cost || 0));
    const purchaseCost = Math.max(0, Number(data.purchaseCost ?? cost));
    const sellingPrice = Math.max(0, Number(data.sellingPrice ?? Math.round(cost * 1.25)));
    const sku = String(data.sku || `SKU-${pid}`).slice(0, 20);
    const name = String(data.productName || data.name || `Product ${pid}`).slice(0, 60);

    const topProdRef = doc(db, 'products', docId);
    batch.set(topProdRef, {
      id: pid,
      productId: docId,
      tenantId: tenantId.slice(0, 64),
      sku,
      name,
      productName: name,
      category: String(data.category || defaultCategoryForSku(sku, name)).slice(0, 40),
      description: String(data.description || `${name} (${sku})`).slice(0, 200),
      unit: String(data.unit || 'units').slice(0, 20),
      cost,
      purchaseCost,
      sellingPrice,
      currentStock,
      lowStockThreshold,
      stockStatus,
      status: (data.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'ACTIVE') as
        | 'ACTIVE'
        | 'DISCONTINUED',
      lead: Math.min(365, Math.max(0, Number(data.lead || 5))),
      opening,
      safety: Math.max(0, Number(data.safety || 10)),
      rop: lowStockThreshold,
      base: Math.max(0, Number(data.base || 5)),
      sup: Math.max(1, Number(data.sup || 1)),
      isSample: Boolean(data.isSample),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
}

async function seedMissingCollectionsOnly(
  tenantId: string,
  seedState: TenantDataState
): Promise<void> {
  const batch = writeBatch(db);

  seedState.suppliers.forEach((s, idx) => {
    const meta = defaultSupplierMeta(s, idx);
    const sRef = doc(db, 'tenants', tenantId, 'suppliers', String(s.id));
    batch.set(sRef, {
      id: Number(s.id),
      tenantId: tenantId.slice(0, 64),
      name: s.name.slice(0, 80),
      contactPerson: meta.contactPerson,
      email: meta.email,
      phone: meta.phone,
      address: meta.address,
      status: meta.status,
      isSample: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  for (const p of seedState.products) {
    const txSum = sum(seedState.transactions.filter((t) => t.pid === p.id).map((t) => t.qty));
    const qtyOnHand = Math.max(0, p.opening + txSum);
    const invStatus: StockStatusLabel = computeStockStatusLabel(qtyOnHand, p.rop);

    const invRef = doc(db, 'tenants', tenantId, 'inventory', String(p.id));
    batch.set(invRef, {
      productId: Number(p.id),
      tenantId: tenantId.slice(0, 64),
      sku: p.sku.slice(0, 20),
      productName: p.name.slice(0, 60),
      quantityOnHand: qtyOnHand,
      reorderLevel: Math.max(0, Number(p.rop)),
      safetyStock: Math.max(0, Number(p.safety)),
      warehouseLocation: defaultWarehouseForProduct(p.id, tenantId),
      status: invStatus,
      isSample: true,
      lastUpdated: serverTimestamp(),
    });

    const series = (seedState.demand[p.id] || []).slice(-90);
    const H = 14;
    const tr = series.slice(0, -H);
    const te = series.slice(-H);
    const meanTrain = tr.length ? sum(tr) / tr.length : 0;
    const lastTrain = tr[tr.length - 1] || 0;
    const maeMean = te.length
      ? Number((sum(te.map((x) => Math.abs(x - meanTrain))) / te.length).toFixed(2))
      : 0;
    const maeNaive = te.length
      ? Number((sum(te.map((x) => Math.abs(x - lastTrain))) / te.length).toFixed(2))
      : 0;
    const predDaily = series.length ? Number((sum(series.slice(-30)) / 30).toFixed(2)) : 0;

    const fRef = doc(db, 'tenants', tenantId, 'forecasts', String(p.id));
    batch.set(fRef, {
      productId: Number(p.id),
      tenantId: tenantId.slice(0, 64),
      sku: p.sku.slice(0, 20),
      productName: p.name.slice(0, 60),
      forecastPeriod: 'Next 14 Days',
      windowDays: 30,
      historySeries: series,
      predictedDailyDemand: Math.max(0, predDaily),
      projectedPeriodTotal: Math.max(0, Math.round(predDaily * 14)),
      method: '30-Day Moving Average Baseline',
      maeMean: Math.max(0, maeMean),
      maeNaive: Math.max(0, maeNaive),
      isSample: true,
      generatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
}

async function writeSampleTenantRecords(
  uid: string,
  userEmail: string,
  seedState: TenantDataState
): Promise<void> {
  const tenantId = seedState.tenant.id;
  const cleanEmail = (userEmail || 'authenticated@supplychain.io').slice(0, 120);
  const batch = writeBatch(db);

  // 1. Suppliers
  seedState.suppliers.forEach((s, idx) => {
    const meta = defaultSupplierMeta(s, idx);
    const sRef = doc(db, 'tenants', tenantId, 'suppliers', String(s.id));
    batch.set(sRef, {
      id: Number(s.id),
      tenantId: tenantId.slice(0, 64),
      name: s.name.slice(0, 80),
      contactPerson: meta.contactPerson,
      email: meta.email,
      phone: meta.phone,
      address: meta.address,
      status: meta.status,
      isSample: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  // 2. Products, Inventory & Forecasts
  for (const p of seedState.products) {
    const txSum = sum(seedState.transactions.filter((t) => t.pid === p.id).map((t) => t.qty));
    const qtyOnHand = Math.max(0, p.opening + txSum);
    const lowStockThreshold = Math.max(0, Number(p.lowStockThreshold ?? p.rop));
    const stockStatus: StockStatusLabel = computeStockStatusLabel(qtyOnHand, lowStockThreshold);
    const costVal = Math.max(0, Number(p.cost));
    const sellVal = Math.max(0, Number(p.sellingPrice || Math.round(costVal * 1.25)));

    const docId = formatProductId(p.id, p.productId);
    const pRef = doc(db, 'products', docId);
    batch.set(pRef, {
      id: Number(p.id),
      productId: docId,
      tenantId: tenantId.slice(0, 64),
      sku: p.sku.slice(0, 20),
      name: p.name.slice(0, 60),
      productName: p.name.slice(0, 60),
      category: (p.category || defaultCategoryForSku(p.sku, p.name)).slice(0, 40),
      description: (
        p.description || `Sample catalog item ${p.name} (${p.sku}) — Lead time ${p.lead}d`
      ).slice(0, 200),
      unit: (p.unit || 'units').slice(0, 20),
      cost: costVal,
      purchaseCost: costVal,
      sellingPrice: sellVal,
      currentStock: qtyOnHand,
      lowStockThreshold,
      stockStatus,
      status: (p.status || 'ACTIVE') as 'ACTIVE' | 'DISCONTINUED',
      lead: Math.min(365, Math.max(0, Number(p.lead))),
      opening: Math.max(0, Number(p.opening)),
      safety: Math.max(0, Number(p.safety)),
      rop: lowStockThreshold,
      base: Math.max(0, Number(p.base)),
      sup: Math.max(1, Number(p.sup)),
      isSample: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const invRef = doc(db, 'tenants', tenantId, 'inventory', String(p.id));
    batch.set(invRef, {
      productId: Number(p.id),
      tenantId: tenantId.slice(0, 64),
      sku: p.sku.slice(0, 20),
      productName: p.name.slice(0, 60),
      quantityOnHand: qtyOnHand,
      reorderLevel: lowStockThreshold,
      safetyStock: Math.max(0, Number(p.safety)),
      warehouseLocation: defaultWarehouseForProduct(p.id, tenantId),
      status: stockStatus,
      isSample: true,
      lastUpdated: serverTimestamp(),
    });

    const series = (seedState.demand[p.id] || []).slice(-90);
    const H = 14;
    const tr = series.slice(0, -H);
    const te = series.slice(-H);
    const meanTrain = tr.length ? sum(tr) / tr.length : 0;
    const lastTrain = tr[tr.length - 1] || 0;
    const maeMean = te.length
      ? Number((sum(te.map((x) => Math.abs(x - meanTrain))) / te.length).toFixed(2))
      : 0;
    const maeNaive = te.length
      ? Number((sum(te.map((x) => Math.abs(x - lastTrain))) / te.length).toFixed(2))
      : 0;
    const predDaily = series.length ? Number((sum(series.slice(-30)) / 30).toFixed(2)) : 0;

    const fRef = doc(db, 'tenants', tenantId, 'forecasts', String(p.id));
    batch.set(fRef, {
      productId: Number(p.id),
      tenantId: tenantId.slice(0, 64),
      sku: p.sku.slice(0, 20),
      productName: p.name.slice(0, 60),
      forecastPeriod: 'Next 14 Days',
      windowDays: 30,
      historySeries: series,
      predictedDailyDemand: Math.max(0, predDaily),
      projectedPeriodTotal: Math.max(0, Math.round(predDaily * 14)),
      method: '30-Day Moving Average Baseline',
      maeMean: Math.max(0, maeMean),
      maeNaive: Math.max(0, maeNaive),
      isSample: true,
      generatedAt: serverTimestamp(),
    });

    if (stockStatus !== 'In Stock') {
      const notifId = `notif-seed-${p.id}`;
      const nRef = doc(db, 'tenants', tenantId, 'notifications', notifId);
      batch.set(nRef, {
        id: notifId,
        tenantId: tenantId.slice(0, 64),
        userId: uid.slice(0, 128),
        message: `${p.name} (${p.sku}) is ${stockStatus} (${qtyOnHand} units vs threshold ${lowStockThreshold}).`,
        type: qtyOnHand <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
        relatedRecordId: p.sku.slice(0, 64),
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }

  // 3. Inventory Transactions (with running resultingStock calculation)
  const runningByProd: Record<number, number> = {};
  for (const p of seedState.products) {
    runningByProd[p.id] = Math.max(0, Number(p.opening));
  }
  const sortedTxs = [...seedState.transactions].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id
  );
  for (const tx of sortedTxs) {
    const prod = seedState.products.find((p) => p.id === tx.pid);
    const prevStock = runningByProd[tx.pid] ?? 0;
    const resultingStock = Math.max(0, prevStock + Number(tx.qty));
    runningByProd[tx.pid] = resultingStock;

    const movementType: StockMovementType =
      tx.type === 'IN' ? 'PURCHASE' : tx.type === 'OUT' ? 'SALE' : 'ADJUST';

    const txRef = doc(db, 'tenants', tenantId, 'inventoryTransactions', String(tx.id));
    batch.set(txRef, {
      id: Number(tx.id),
      tenantId: tenantId.slice(0, 64),
      pid: Number(tx.pid),
      productId: String(tx.pid),
      productName: (prod?.name || `Product #${tx.pid}`).slice(0, 60),
      date: tx.date.slice(0, 10),
      type: tx.type,
      transactionType: movementType,
      qty: Number(tx.qty),
      quantity: Math.max(1, Math.abs(Number(tx.qty))),
      resultingStock,
      note: (tx.note || '-').slice(0, 120),
      relatedOrderId: (tx.relatedOrderId || '-').slice(0, 32),
      actorEmail: (tx.actorName || cleanEmail).slice(0, 120),
      isSample: true,
      createdAt: serverTimestamp(),
    });
  }

  // 4. Purchase Orders
  for (const po of seedState.purchaseOrders) {
    const prod = seedState.products.find((p) => p.id === po.pid);
    const unitPrice = prod ? prod.cost : 1000;
    const poRef = doc(db, 'tenants', tenantId, 'purchaseOrders', po.id);
    batch.set(poRef, {
      id: po.id.slice(0, 32),
      tenantId: tenantId.slice(0, 64),
      sup: Number(po.sup),
      pid: Number(po.pid),
      productName: (prod?.name || `Product #${po.pid}`).slice(0, 60),
      qty: Math.max(1, Number(po.qty)),
      unitPrice: Math.max(0, Number(unitPrice)),
      total: Math.max(0, Number(unitPrice) * Math.max(1, Number(po.qty))),
      od: po.od.slice(0, 10),
      ex: po.ex.slice(0, 10),
      rc: po.rc ? po.rc.slice(0, 10) : '',
      st: po.st,
      isSample: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 5. Audit Logs
  for (const log of seedState.auditLogs) {
    const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(log.id));
    batch.set(logRef, {
      id: Number(log.id),
      tenantId: tenantId.slice(0, 64),
      k: log.k.slice(0, 40),
      m: log.m.slice(0, 200),
      d: log.d.slice(0, 10),
      actorEmail: (log.actorEmail || cleanEmail).slice(0, 120),
      actorRole: log.actorRole,
      severity: log.severity,
      n: Number(log.n),
      createdAt: serverTimestamp(),
    });
  }

  await batch.commit();
}

export function subscribeToTenantCollections(
  tenantId: string,
  callbacks: {
    onProducts: (products: Product[]) => void;
    onInventory: (inventory: InventoryRecord[]) => void;
    onSuppliers: (suppliers: Supplier[]) => void;
    onTransactions: (transactions: InventoryTransaction[]) => void;
    onPurchaseOrders: (pos: PurchaseOrder[]) => void;
    onForecasts: (forecasts: ForecastRecord[]) => void;
    onNotifications: (notifications: NotificationRecord[]) => void;
    onReports: (reports: ReportRecord[]) => void;
    onAuditLogs: (logs: AuditLogEntry[]) => void;
    onLoaded: () => void;
  }
): () => void {
  const productsPath = 'products';
  const inventoryPath = `tenants/${tenantId}/inventory`;
  const suppliersPath = `tenants/${tenantId}/suppliers`;
  const txPath = `tenants/${tenantId}/inventoryTransactions`;
  const poPath = `tenants/${tenantId}/purchaseOrders`;
  const forecastsPath = `tenants/${tenantId}/forecasts`;
  const notificationsPath = `tenants/${tenantId}/notifications`;
  const reportsPath = `tenants/${tenantId}/reports`;
  const logsPath = `tenants/${tenantId}/auditLogs`;

  let initialLoaded = false;
  const markLoaded = () => {
    if (!initialLoaded) {
      initialLoaded = true;
      callbacks.onLoaded();
    }
  };

  const unsubProducts = onSnapshot(
    query(collection(db, productsPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: Product[] = snap.docs
        .map((d) => {
          const data = d.data();
          const idNum = Number(data.id);
          const costNum = Number(data.purchaseCost ?? data.cost ?? 0);
          const sellNum =
            data.sellingPrice !== undefined
              ? Number(data.sellingPrice)
              : Math.round(costNum * 1.25);
          const ropNum = Number(data.lowStockThreshold ?? data.rop ?? 0);
          const curStockNum =
            data.currentStock !== undefined ? Number(data.currentStock) : Number(data.opening ?? 0);
          const autoStatus = computeStockStatusLabel(curStockNum, ropNum);
          const prodName = String(data.productName || data.name || '');

          return {
            id: idNum,
            productId: formatProductId(idNum, String(data.productId || d.id || '')),
            tenantId: String(data.tenantId),
            sku: String(data.sku),
            name: prodName,
            productName: prodName,
            category: data.category ? String(data.category) : 'General Electronics',
            description: data.description ? String(data.description) : '',
            unit: data.unit ? String(data.unit) : 'units',
            cost: costNum,
            purchaseCost: costNum,
            sellingPrice: sellNum,
            currentStock: curStockNum,
            lowStockThreshold: ropNum,
            stockStatus: autoStatus,
            status: (data.status as 'ACTIVE' | 'DISCONTINUED') || 'ACTIVE',
            lead: Number(data.lead),
            opening: Number(data.opening),
            safety: Number(data.safety),
            rop: ropNum,
            base: Number(data.base),
            sup: Number(data.sup),
            isSample: Boolean(data.isSample),
            createdAt: formatTimestamp(data.createdAt),
            updatedAt: formatTimestamp(data.updatedAt),
          };
        })
        .sort((a, b) => a.id - b.id);
      callbacks.onProducts(items);
      markLoaded();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, productsPath)
  );

  const unsubInventory = onSnapshot(
    query(collection(db, inventoryPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: InventoryRecord[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            productId: Number(data.productId),
            tenantId: String(data.tenantId),
            sku: String(data.sku),
            productName: String(data.productName),
            quantityOnHand: Number(data.quantityOnHand),
            reorderLevel: Number(data.reorderLevel),
            safetyStock: Number(data.safetyStock),
            warehouseLocation: String(data.warehouseLocation),
            status: data.status as 'In Stock' | 'Healthy Stock' | 'Low Stock' | 'Out of Stock',
            isSample: Boolean(data.isSample),
            lastUpdated: formatTimestamp(data.lastUpdated),
          };
        })
        .sort((a, b) => a.productId - b.productId);
      callbacks.onInventory(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, inventoryPath)
  );

  const unsubSuppliers = onSnapshot(
    query(collection(db, suppliersPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: Supplier[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: Number(data.id),
            tenantId: String(data.tenantId),
            name: String(data.name),
            contactPerson: String(data.contactPerson || ''),
            email: String(data.email || ''),
            phone: String(data.phone || ''),
            address: String(data.address || ''),
            status: (data.status as 'ACTIVE' | 'ON_HOLD' | 'INACTIVE') || 'ACTIVE',
            isSample: Boolean(data.isSample),
          };
        })
        .sort((a, b) => a.id - b.id);
      callbacks.onSuppliers(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, suppliersPath)
  );

  const unsubTx = onSnapshot(
    query(collection(db, txPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: InventoryTransaction[] = snap.docs
        .map((d) => {
          const data = d.data();
          const rawType = (data.type as 'IN' | 'OUT' | 'ADJUST') || 'IN';
          const movType: StockMovementType =
            (data.transactionType as StockMovementType) ||
            (rawType === 'IN' ? 'PURCHASE' : rawType === 'OUT' ? 'SALE' : 'ADJUST');
          const signedQty = Number(data.qty);
          const ts = formatTimestamp(data.createdAt, `${String(data.date)}T00:00:00.000Z`);

          return {
            id: Number(data.id),
            tenantId: String(data.tenantId),
            pid: Number(data.pid),
            productId: String(data.productId || data.pid),
            productName: data.productName ? String(data.productName) : undefined,
            date: String(data.date),
            type: rawType,
            transactionType: movType,
            qty: signedQty,
            quantity:
              data.quantity !== undefined ? Number(data.quantity) : Math.abs(signedQty),
            resultingStock:
              data.resultingStock !== undefined ? Number(data.resultingStock) : undefined,
            note: String(data.note),
            relatedOrderId: String(data.relatedOrderId || '-'),
            actorName: String(data.actorEmail || 'system@supplychain.io'),
            timestamp: ts,
            createdAt: ts,
            isSample: Boolean(data.isSample),
          };
        })
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
      callbacks.onTransactions(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, txPath)
  );

  const unsubPo = onSnapshot(
    query(collection(db, poPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: PurchaseOrder[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id),
            tenantId: String(data.tenantId),
            sup: Number(data.sup),
            pid: Number(data.pid),
            productName: data.productName ? String(data.productName) : undefined,
            qty: Number(data.qty),
            unitPrice: data.unitPrice !== undefined ? Number(data.unitPrice) : undefined,
            total: data.total !== undefined ? Number(data.total) : undefined,
            od: String(data.od),
            ex: String(data.ex),
            rc: data.rc ? String(data.rc) : null,
            st: data.st as 'pending' | 'received' | 'cancelled',
            isSample: Boolean(data.isSample),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      callbacks.onPurchaseOrders(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, poPath)
  );

  const unsubForecasts = onSnapshot(
    query(collection(db, forecastsPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: ForecastRecord[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            productId: Number(data.productId),
            tenantId: String(data.tenantId),
            sku: String(data.sku),
            productName: String(data.productName),
            forecastPeriod: String(data.forecastPeriod),
            windowDays: Number(data.windowDays),
            historySeries: Array.isArray(data.historySeries)
              ? data.historySeries.map((n: unknown) => Number(n))
              : [],
            predictedDailyDemand: Number(data.predictedDailyDemand),
            projectedPeriodTotal: Number(data.projectedPeriodTotal),
            method: String(data.method),
            maeMean: Number(data.maeMean),
            maeNaive: Number(data.maeNaive),
            isSample: Boolean(data.isSample),
            generatedAt: formatTimestamp(data.generatedAt),
          };
        })
        .sort((a, b) => a.productId - b.productId);
      callbacks.onForecasts(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, forecastsPath)
  );

  const unsubNotifications = onSnapshot(
    query(collection(db, notificationsPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: NotificationRecord[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id),
            tenantId: String(data.tenantId),
            userId: String(data.userId),
            message: String(data.message),
            type: data.type as 'LOW_STOCK' | 'OUT_OF_STOCK' | 'PO_UPDATE' | 'SYSTEM',
            relatedRecordId: String(data.relatedRecordId),
            read: Boolean(data.read),
            createdAt: formatTimestamp(data.createdAt),
          };
        })
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      callbacks.onNotifications(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, notificationsPath)
  );

  const unsubReports = onSnapshot(
    query(collection(db, reportsPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: ReportRecord[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id),
            tenantId: String(data.tenantId),
            reportType: data.reportType as 'CSV_RECOMMENDATIONS' | 'JSON_EXECUTIVE_SUMMARY',
            dateRange: String(data.dateRange),
            summary: String(data.summary),
            totalProducts: Number(data.totalProducts),
            inventoryValue: Number(data.inventoryValue),
            belowRopCount: Number(data.belowRopCount),
            generatedBy: String(data.generatedBy),
            generatedAt: formatTimestamp(data.generatedAt),
          };
        })
        .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
      callbacks.onReports(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, reportsPath)
  );

  const unsubLogs = onSnapshot(
    query(collection(db, logsPath), where('tenantId', '==', tenantId)),
    (snap) => {
      const items: AuditLogEntry[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: Number(data.id),
            tenantId: String(data.tenantId),
            k: String(data.k),
            m: String(data.m),
            d: String(data.d),
            timestamp: formatTimestamp(data.createdAt),
            actorEmail: String(data.actorEmail || 'authenticated@supplychain.io'),
            actorRole: data.actorRole as UserRole,
            ip: 'Firestore-Cloud',
            severity: data.severity as 'INFO' | 'WARN' | 'CRITICAL',
            n: Number(data.n),
          };
        })
        .sort((a, b) => a.n - b.n);
      callbacks.onAuditLogs(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, logsPath)
  );

  return () => {
    unsubProducts();
    unsubInventory();
    unsubSuppliers();
    unsubTx();
    unsubPo();
    unsubForecasts();
    unsubNotifications();
    unsubReports();
    unsubLogs();
  };
}

/**
 * Atomically saves a Product and synchronizes its corresponding Inventory & Forecast documents in Firestore.
 * Automatically calculates `stockStatus` from `currentStock` and `lowStockThreshold` so inconsistent
 * status values can never be saved.
 */
export async function saveProductInFirestore(params: {
  uid: string;
  userEmail: string;
  userRole: UserRole;
  tenantId: string;
  todayStr: string;
  product: Product;
  currentLedgerStock: number;
  warehouseLocation?: string;
  isNew: boolean;
  nextAuditId: number;
}): Promise<void> {
  const {
    uid,
    userEmail,
    userRole,
    tenantId,
    todayStr,
    product,
    currentLedgerStock,
    warehouseLocation,
    isNew,
    nextAuditId,
  } = params;
  const docId = formatProductId(product.id, product.productId);
  const path = `products/${docId}`;
  const prodRef = doc(db, 'products', docId);
  const invRef = doc(db, 'tenants', tenantId, 'inventory', String(product.id));
  const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId));

  const qtyOnHand = Math.max(0, Math.round(Number(currentLedgerStock)));
  const lowStockThreshold = Math.max(
    0,
    Math.round(Number(product.lowStockThreshold ?? product.rop))
  );
  const stockStatus: StockStatusLabel = computeStockStatusLabel(qtyOnHand, lowStockThreshold);
  const purchaseCost = Math.max(0, Number(product.purchaseCost ?? product.cost));
  const sellingPrice = Math.max(
    0,
    Number(product.sellingPrice ?? Math.round(purchaseCost * 1.25))
  );
  const cleanName = (product.productName || product.name).trim().slice(0, 60);
  const cleanCat = (
    product.category || defaultCategoryForSku(product.sku, cleanName)
  )
    .trim()
    .slice(0, 40);
  const whLoc = (
    warehouseLocation || defaultWarehouseForProduct(product.id, tenantId)
  ).slice(0, 60);

  try {
    if (isNew) {
      const existingSnap = await getDoc(prodRef);
      if (existingSnap.exists()) {
        throw new Error(`Duplicate Product ID: "${docId}" already exists in Firestore.`);
      }
    }

    const batch = writeBatch(db);

    if (isNew) {
      batch.set(prodRef, {
        id: Number(product.id),
        productId: docId,
        tenantId: tenantId.slice(0, 64),
        sku: product.sku.slice(0, 20),
        name: cleanName,
        productName: cleanName,
        category: cleanCat,
        description: (product.description || `${cleanName} (${product.sku})`).slice(0, 200),
        unit: (product.unit || 'units').slice(0, 20),
        cost: purchaseCost,
        purchaseCost,
        sellingPrice,
        currentStock: qtyOnHand,
        lowStockThreshold,
        stockStatus,
        status: (product.status || 'ACTIVE') as 'ACTIVE' | 'DISCONTINUED',
        lead: Math.min(365, Math.max(0, Number(product.lead))),
        opening: Math.max(0, Number(product.opening)),
        safety: Math.max(0, Number(product.safety)),
        rop: lowStockThreshold,
        base: Math.max(0, Number(product.base || 5)),
        sup: Math.max(1, Number(product.sup)),
        isSample: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(invRef, {
        productId: Number(product.id),
        tenantId: tenantId.slice(0, 64),
        sku: product.sku.slice(0, 20),
        productName: cleanName,
        quantityOnHand: qtyOnHand,
        reorderLevel: lowStockThreshold,
        safetyStock: Math.max(0, Number(product.safety)),
        warehouseLocation: whLoc,
        status: stockStatus,
        isSample: false,
        lastUpdated: serverTimestamp(),
      });

      const forecastRef = doc(db, 'tenants', tenantId, 'forecasts', String(product.id));
      batch.set(forecastRef, {
        productId: Number(product.id),
        tenantId: tenantId.slice(0, 64),
        sku: product.sku.slice(0, 20),
        productName: cleanName,
        forecastPeriod: 'Next 14 Days',
        windowDays: 30,
        historySeries: Array.from({ length: 90 }, () => Math.max(0, Number(product.base || 0))),
        predictedDailyDemand: Math.max(0, Number(product.base || 0)),
        projectedPeriodTotal: Math.max(0, Math.round(Number(product.base || 0) * 14)),
        method: '30-Day Moving Average Baseline',
        maeMean: 0,
        maeNaive: 0,
        isSample: false,
        generatedAt: serverTimestamp(),
      });
    } else {
      batch.update(prodRef, {
        productId: docId,
        sku: product.sku.slice(0, 20),
        name: cleanName,
        productName: cleanName,
        category: cleanCat,
        description: (product.description || `${cleanName} (${product.sku})`).slice(0, 200),
        unit: (product.unit || 'units').slice(0, 20),
        cost: purchaseCost,
        purchaseCost,
        sellingPrice,
        currentStock: qtyOnHand,
        lowStockThreshold,
        stockStatus,
        status: (product.status || 'ACTIVE') as 'ACTIVE' | 'DISCONTINUED',
        lead: Math.min(365, Math.max(0, Number(product.lead))),
        opening: Math.max(0, Number(product.opening)),
        safety: Math.max(0, Number(product.safety)),
        rop: lowStockThreshold,
        sup: Math.max(1, Number(product.sup)),
        isSample: false,
        updatedAt: serverTimestamp(),
      });

      batch.set(
        invRef,
        {
          productId: Number(product.id),
          tenantId: tenantId.slice(0, 64),
          sku: product.sku.slice(0, 20),
          productName: cleanName,
          quantityOnHand: qtyOnHand,
          reorderLevel: lowStockThreshold,
          safetyStock: Math.max(0, Number(product.safety)),
          warehouseLocation: whLoc,
          status: stockStatus,
          isSample: false,
          lastUpdated: serverTimestamp(),
        },
        { merge: false }
      );
    }

    batch.set(logRef, {
      id: Number(nextAuditId),
      tenantId: tenantId.slice(0, 64),
      k: isNew ? 'Product added' : 'Product updated',
      m: `${cleanName} (${docId} / ${product.sku}) ${isNew ? 'added to' : 'updated in'} Firestore [Stock: ${qtyOnHand}, Status: ${stockStatus}]`.slice(
        0,
        200
      ),
      d: todayStr.slice(0, 10),
      actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: userRole,
      severity: 'INFO',
      n: Number(nextAuditId),
      createdAt: serverTimestamp(),
    });

    if (stockStatus !== 'In Stock') {
      const notifId = `notif-prod-${product.id}-${Date.now()}`.slice(0, 64);
      batch.set(doc(db, 'tenants', tenantId, 'notifications', notifId), {
        id: notifId,
        tenantId: tenantId.slice(0, 64),
        userId: uid.slice(0, 128),
        message: `${cleanName} (${docId}) is ${stockStatus} (${qtyOnHand} units on hand vs threshold ${lowStockThreshold}).`.slice(
          0,
          200
        ),
        type: qtyOnHand <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
        relatedRecordId: docId.slice(0, 64),
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Duplicate Product ID:')) {
      throw error;
    }
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deleteProductFromFirestore(params: {
  tenantId: string;
  product: Product;
  relatedTxIds: number[];
  userEmail: string;
  userRole: UserRole;
  todayStr: string;
  nextAuditId: number;
}): Promise<void> {
  const { tenantId, product, relatedTxIds, userEmail, userRole, todayStr, nextAuditId } = params;
  const docId = formatProductId(product.id, product.productId);
  const path = `products/${docId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'products', docId));
    batch.delete(doc(db, 'tenants', tenantId, 'products', String(product.id)));
    batch.delete(doc(db, 'tenants', tenantId, 'inventory', String(product.id)));
    batch.delete(doc(db, 'tenants', tenantId, 'forecasts', String(product.id)));
    for (const txId of relatedTxIds) {
      batch.delete(doc(db, 'tenants', tenantId, 'inventoryTransactions', String(txId)));
    }
    batch.set(doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId)), {
      id: Number(nextAuditId),
      tenantId: tenantId.slice(0, 64),
      k: 'Product removed',
      m: `${product.name} (${docId} / ${product.sku}) deleted from Firestore`.slice(0, 200),
      d: todayStr.slice(0, 10),
      actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: userRole,
      severity: 'WARN',
      n: Number(nextAuditId),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

/**
 * Atomically records a Stock Purchase (PURCHASE / IN), Stock Sale (SALE / OUT), or Adjustment (ADJUST)
 * using a Firestore Transaction (`runTransaction`).
 * - Prevents duplicate transaction processing via both an in-flight lock and a transaction document existence check.
 * - Prevents negative stock on sales (`updatedStock < 0` is rejected before any write).
 * - Automatically recalculates `stockStatus` ("In Stock" | "Low Stock" | "Out of Stock") from `currentStock` and `lowStockThreshold`.
 * - Atomically updates `products/{productId}`, `inventory/{productId}`, and creates `inventoryTransactions/{txId}` with `resultingStock`.
 */
export async function recordInventoryTransactionInFirestore(params: {
  uid: string;
  userEmail: string;
  userRole: UserRole;
  tenantId: string;
  product: Product;
  currentLedgerStock: number;
  tx: InventoryTransaction;
  nextAuditId: number;
}): Promise<number> {
  const { uid, userEmail, userRole, tenantId, product, currentLedgerStock, tx, nextAuditId } =
    params;
  const lockKey = `${tenantId}:${product.id}:${tx.id}`;
  if (inFlightTxLocks.has(lockKey)) {
    throw new Error('Rejected: Duplicate transaction is already being processed.');
  }
  inFlightTxLocks.add(lockKey);

  const docId = formatProductId(product.id, product.productId);
  const path = `tenants/${tenantId}/inventoryTransactions/${tx.id}`;
  const prodRef = doc(db, 'products', docId);
  const invRef = doc(db, 'tenants', tenantId, 'inventory', String(product.id));
  const txRef = doc(db, 'tenants', tenantId, 'inventoryTransactions', String(tx.id));
  const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId));

  try {
    const newBalance = await runTransaction(db, async (transaction) => {
      const [existingTxSnap, prodSnap, invSnap] = await Promise.all([
        transaction.get(txRef),
        transaction.get(prodRef),
        transaction.get(invRef),
      ]);

      if (existingTxSnap.exists()) {
        throw new Error('Rejected: This stock transaction has already been processed.');
      }

      const baseBalance = prodSnap.exists() && prodSnap.data().currentStock !== undefined
        ? Number(prodSnap.data().currentStock)
        : invSnap.exists()
        ? Number(invSnap.data().quantityOnHand)
        : currentLedgerStock;

      const delta = Number(tx.qty);
      if (!Number.isInteger(delta) || delta === 0) {
        throw new Error('Rejected: Quantity must be a non-zero whole number.');
      }

      const updatedStock = baseBalance + delta;
      if (updatedStock < 0) {
        throw new Error(
          `Rejected: Stock cannot become negative (available: ${baseBalance} units, requested change: ${delta}).`
        );
      }

      const threshold = Math.max(
        0,
        Number(
          prodSnap.exists() && prodSnap.data().lowStockThreshold !== undefined
            ? prodSnap.data().lowStockThreshold
            : product.lowStockThreshold ?? product.rop
        )
      );
      const newStockStatus: StockStatusLabel = computeStockStatusLabel(updatedStock, threshold);
      const whLoc = invSnap.exists()
        ? String(
            invSnap.data().warehouseLocation || defaultWarehouseForProduct(product.id, tenantId)
          )
        : defaultWarehouseForProduct(product.id, tenantId);

      const movementType: StockMovementType =
        tx.transactionType ||
        (tx.type === 'IN' ? 'PURCHASE' : tx.type === 'OUT' ? 'SALE' : 'ADJUST');

      if (prodSnap.exists()) {
        transaction.update(prodRef, {
          productId: docId,
          productName: (product.productName || product.name).slice(0, 60),
          purchaseCost: Math.max(0, Number(product.purchaseCost ?? product.cost)),
          currentStock: updatedStock,
          lowStockThreshold: threshold,
          stockStatus: newStockStatus,
          isSample: false,
          updatedAt: serverTimestamp(),
        });
      }

      transaction.set(txRef, {
        id: Number(tx.id),
        tenantId: tenantId.slice(0, 64),
        pid: Number(tx.pid),
        productId: docId,
        productName: (product.productName || product.name).slice(0, 60),
        date: tx.date.slice(0, 10),
        type: tx.type,
        transactionType: movementType,
        qty: delta,
        quantity: Math.max(1, Math.abs(delta)),
        resultingStock: updatedStock,
        note: (tx.note || '-').slice(0, 120),
        relatedOrderId: (tx.relatedOrderId || '-').slice(0, 32),
        actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
        isSample: false,
        createdAt: serverTimestamp(),
      });

      transaction.set(invRef, {
        productId: Number(product.id),
        tenantId: tenantId.slice(0, 64),
        sku: product.sku.slice(0, 20),
        productName: (product.productName || product.name).slice(0, 60),
        quantityOnHand: updatedStock,
        reorderLevel: threshold,
        safetyStock: Math.max(0, Number(product.safety)),
        warehouseLocation: whLoc.slice(0, 60),
        status: newStockStatus,
        isSample: false,
        lastUpdated: serverTimestamp(),
      });

      transaction.set(logRef, {
        id: Number(nextAuditId),
        tenantId: tenantId.slice(0, 64),
        k: `Stock ${movementType}`,
        m: `${movementType} (${tx.type}) ${Math.abs(delta)} × ${product.name} → Resulting stock: ${updatedStock} (${newStockStatus})`.slice(
          0,
          200
        ),
        d: tx.date.slice(0, 10),
        actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
        actorRole: userRole,
        severity: tx.type === 'ADJUST' ? 'WARN' : 'INFO',
        n: Number(nextAuditId),
        createdAt: serverTimestamp(),
      });

      if (newStockStatus !== 'In Stock') {
        const notifId = `notif-tx-${tx.id}`.slice(0, 64);
        const notifRef = doc(db, 'tenants', tenantId, 'notifications', notifId);
        transaction.set(notifRef, {
          id: notifId,
          tenantId: tenantId.slice(0, 64),
          userId: uid.slice(0, 128),
          message: `Alert: ${product.name} (${product.sku}) reached ${updatedStock} units (${newStockStatus}, threshold ${threshold}).`.slice(
            0,
            200
          ),
          type: updatedStock <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
          relatedRecordId: product.sku.slice(0, 64),
          read: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      return updatedStock;
    });

    return newBalance;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Rejected:')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.CREATE, path);
  } finally {
    inFlightTxLocks.delete(lockKey);
  }
}

export async function createPurchaseOrderInFirestore(params: {
  uid: string;
  userEmail: string;
  userRole: UserRole;
  tenantId: string;
  todayStr: string;
  po: PurchaseOrder;
  product: Product;
  nextAuditId: number;
}): Promise<void> {
  const { uid, userEmail, userRole, tenantId, todayStr, po, product, nextAuditId } = params;
  const path = `tenants/${tenantId}/purchaseOrders/${po.id}`;
  const poRef = doc(db, 'tenants', tenantId, 'purchaseOrders', po.id);
  const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId));
  const notifId = `notif-po-${po.id}`.slice(0, 64);
  const notifRef = doc(db, 'tenants', tenantId, 'notifications', notifId);

  const unitPrice = Math.max(0, Number(po.unitPrice ?? product.cost));
  const qty = Math.max(1, Number(po.qty));

  try {
    const batch = writeBatch(db);
    batch.set(poRef, {
      id: po.id.slice(0, 32),
      tenantId: tenantId.slice(0, 64),
      sup: Number(po.sup),
      pid: Number(po.pid),
      productName: product.name.slice(0, 60),
      qty,
      unitPrice,
      total: unitPrice * qty,
      od: po.od.slice(0, 10),
      ex: po.ex.slice(0, 10),
      rc: '',
      st: 'pending',
      isSample: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(logRef, {
      id: Number(nextAuditId),
      tenantId: tenantId.slice(0, 64),
      k: 'Purchase order',
      m: `${po.id} created (${qty} × ${product.name}), expected ${po.ex}`.slice(0, 200),
      d: todayStr.slice(0, 10),
      actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: userRole,
      severity: 'INFO',
      n: Number(nextAuditId),
      createdAt: serverTimestamp(),
    });

    batch.set(notifRef, {
      id: notifId,
      tenantId: tenantId.slice(0, 64),
      userId: uid.slice(0, 128),
      message: `Purchase Order ${po.id} queued for ${qty} units of ${product.name} (expected ${po.ex}).`.slice(
        0,
        200
      ),
      type: 'PO_UPDATE',
      relatedRecordId: po.id.slice(0, 64),
      read: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Atomically updates a Purchase Order status ('received' or 'cancelled').
 * When 'received', uses `runTransaction` to update the PO, insert a PURCHASE (`IN`) record in
 * `inventoryTransactions` with `resultingStock`, and increment `products/{productId}` and `inventory/{productId}` atomically.
 */
export async function updatePurchaseOrderStatusInFirestore(params: {
  uid: string;
  userEmail: string;
  userRole: UserRole;
  tenantId: string;
  todayStr: string;
  po: PurchaseOrder;
  newStatus: 'received' | 'cancelled';
  product?: Product;
  currentLedgerStock: number;
  nextTxId: number;
  nextAuditId: number;
}): Promise<void> {
  const {
    uid,
    userEmail,
    userRole,
    tenantId,
    todayStr,
    po,
    newStatus,
    product,
    currentLedgerStock,
    nextTxId,
    nextAuditId,
  } = params;
  const path = `tenants/${tenantId}/purchaseOrders/${po.id}`;
  const poRef = doc(db, 'tenants', tenantId, 'purchaseOrders', po.id);
  const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId));

  try {
    await runTransaction(db, async (transaction) => {
      let invSnap = null;
      let prodSnap = null;
      const docId = product ? formatProductId(product.id, product.productId) : '';
      const invRef = product
        ? doc(db, 'tenants', tenantId, 'inventory', String(product.id))
        : null;
      const prodRef = product
        ? doc(db, 'products', docId)
        : null;
      if (invRef && prodRef && newStatus === 'received') {
        [invSnap, prodSnap] = await Promise.all([
          transaction.get(invRef),
          transaction.get(prodRef),
        ]);
      }

      transaction.update(poRef, {
        rc: newStatus === 'received' ? todayStr.slice(0, 10) : '',
        st: newStatus,
        isSample: false,
        updatedAt: serverTimestamp(),
      });

      if (newStatus === 'received' && product && invRef && prodRef) {
        const prevQty =
          prodSnap && prodSnap.exists() && prodSnap.data().currentStock !== undefined
            ? Number(prodSnap.data().currentStock)
            : invSnap && invSnap.exists()
            ? Number(invSnap.data().quantityOnHand)
            : currentLedgerStock;
        const newQty = Math.max(0, prevQty + Number(po.qty));
        const threshold = Math.max(0, Number(product.lowStockThreshold ?? product.rop));
        const newStockStatus: StockStatusLabel = computeStockStatusLabel(newQty, threshold);
        const whLoc =
          invSnap && invSnap.exists()
            ? String(
                invSnap.data().warehouseLocation ||
                  defaultWarehouseForProduct(product.id, tenantId)
              )
            : defaultWarehouseForProduct(product.id, tenantId);

        if (prodSnap && prodSnap.exists()) {
          transaction.update(prodRef, {
            productId: docId,
            productName: (product.productName || product.name).slice(0, 60),
            purchaseCost: Math.max(0, Number(product.purchaseCost ?? product.cost)),
            currentStock: newQty,
            lowStockThreshold: threshold,
            stockStatus: newStockStatus,
            isSample: false,
            updatedAt: serverTimestamp(),
          });
        }

        const txRef = doc(db, 'tenants', tenantId, 'inventoryTransactions', String(nextTxId));
        transaction.set(txRef, {
          id: Number(nextTxId),
          tenantId: tenantId.slice(0, 64),
          pid: Number(product.id),
          productId: docId,
          productName: (product.productName || product.name).slice(0, 60),
          date: todayStr.slice(0, 10),
          type: 'IN',
          transactionType: 'PURCHASE',
          qty: Number(po.qty),
          quantity: Math.max(1, Number(po.qty)),
          resultingStock: newQty,
          note: `PO receipt ${po.id}`.slice(0, 120),
          relatedOrderId: po.id.slice(0, 32),
          actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
          isSample: false,
          createdAt: serverTimestamp(),
        });

        transaction.set(invRef, {
          productId: Number(product.id),
          tenantId: tenantId.slice(0, 64),
          sku: product.sku.slice(0, 20),
          productName: (product.productName || product.name).slice(0, 60),
          quantityOnHand: newQty,
          reorderLevel: threshold,
          safetyStock: Math.max(0, Number(product.safety)),
          warehouseLocation: whLoc.slice(0, 60),
          status: newStockStatus,
          isSample: false,
          lastUpdated: serverTimestamp(),
        });
      }

      transaction.set(logRef, {
        id: Number(nextAuditId),
        tenantId: tenantId.slice(0, 64),
        k: 'Purchase order',
        m:
          newStatus === 'received'
            ? `${po.id} received (+${po.qty} units credited to ledger)`.slice(0, 200)
            : `${po.id} cancelled`.slice(0, 200),
        d: todayStr.slice(0, 10),
        actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
        actorRole: userRole,
        severity: newStatus === 'cancelled' ? 'WARN' : 'INFO',
        n: Number(nextAuditId),
        createdAt: serverTimestamp(),
      });

      const notifId = `notif-po-upd-${po.id}-${Date.now()}`.slice(0, 64);
      transaction.set(doc(db, 'tenants', tenantId, 'notifications', notifId), {
        id: notifId,
        tenantId: tenantId.slice(0, 64),
        userId: uid.slice(0, 128),
        message: `Purchase Order ${po.id} marked as ${newStatus.toUpperCase()}.`.slice(0, 200),
        type: 'PO_UPDATE',
        relatedRecordId: po.id.slice(0, 64),
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveSupplierInFirestore(params: {
  tenantId: string;
  supplier: Supplier;
  isNew: boolean;
  userEmail: string;
  userRole: UserRole;
  todayStr: string;
  nextAuditId: number;
}): Promise<void> {
  const { tenantId, supplier, isNew, userEmail, userRole, todayStr, nextAuditId } = params;
  const path = `tenants/${tenantId}/suppliers/${supplier.id}`;
  const supRef = doc(db, 'tenants', tenantId, 'suppliers', String(supplier.id));
  const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId));

  try {
    const batch = writeBatch(db);
    if (isNew) {
      batch.set(supRef, {
        id: Number(supplier.id),
        tenantId: tenantId.slice(0, 64),
        name: supplier.name.slice(0, 80),
        contactPerson: (supplier.contactPerson || 'Operations Desk').slice(0, 60),
        email: (supplier.email || 'orders@supplier.io').slice(0, 100),
        phone: (supplier.phone || '+91-80-4000-0000').slice(0, 30),
        address: (supplier.address || 'Industrial Logistics Park').slice(0, 150),
        status: (supplier.status || 'ACTIVE') as 'ACTIVE' | 'ON_HOLD' | 'INACTIVE',
        isSample: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(supRef, {
        name: supplier.name.slice(0, 80),
        contactPerson: (supplier.contactPerson || 'Operations Desk').slice(0, 60),
        email: (supplier.email || 'orders@supplier.io').slice(0, 100),
        phone: (supplier.phone || '+91-80-4000-0000').slice(0, 30),
        address: (supplier.address || 'Industrial Logistics Park').slice(0, 150),
        status: (supplier.status || 'ACTIVE') as 'ACTIVE' | 'ON_HOLD' | 'INACTIVE',
        isSample: false,
        updatedAt: serverTimestamp(),
      });
    }

    batch.set(logRef, {
      id: Number(nextAuditId),
      tenantId: tenantId.slice(0, 64),
      k: isNew ? 'Supplier added' : 'Supplier updated',
      m: `Supplier ${supplier.name} ${isNew ? 'added' : 'updated'} in Firestore`.slice(0, 200),
      d: todayStr.slice(0, 10),
      actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: userRole,
      severity: 'INFO',
      n: Number(nextAuditId),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deleteSupplierFromFirestore(params: {
  tenantId: string;
  supplier: Supplier;
  userEmail: string;
  userRole: UserRole;
  todayStr: string;
  nextAuditId: number;
}): Promise<void> {
  const { tenantId, supplier, userEmail, userRole, todayStr, nextAuditId } = params;
  const path = `tenants/${tenantId}/suppliers/${supplier.id}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'tenants', tenantId, 'suppliers', String(supplier.id)));
    batch.set(doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId)), {
      id: Number(nextAuditId),
      tenantId: tenantId.slice(0, 64),
      k: 'Supplier removed',
      m: `Supplier ${supplier.name} deleted from Firestore`.slice(0, 200),
      d: todayStr.slice(0, 10),
      actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: userRole,
      severity: 'WARN',
      n: Number(nextAuditId),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveForecastInFirestore(params: {
  tenantId: string;
  forecast: ForecastRecord;
  userEmail: string;
  userRole: UserRole;
  todayStr: string;
  nextAuditId: number;
}): Promise<void> {
  const { tenantId, forecast, userEmail, userRole, todayStr, nextAuditId } = params;
  const path = `tenants/${tenantId}/forecasts/${forecast.productId}`;
  const fRef = doc(db, 'tenants', tenantId, 'forecasts', String(forecast.productId));
  const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(nextAuditId));

  try {
    const batch = writeBatch(db);
    batch.set(fRef, {
      productId: Number(forecast.productId),
      tenantId: tenantId.slice(0, 64),
      sku: forecast.sku.slice(0, 20),
      productName: forecast.productName.slice(0, 60),
      forecastPeriod: forecast.forecastPeriod.slice(0, 30),
      windowDays: Math.min(90, Math.max(1, Number(forecast.windowDays))),
      historySeries: forecast.historySeries.slice(-90).map((n) => Number(n)),
      predictedDailyDemand: Math.max(0, Number(forecast.predictedDailyDemand.toFixed(2))),
      projectedPeriodTotal: Math.max(0, Math.round(forecast.projectedPeriodTotal)),
      method: forecast.method.slice(0, 60),
      maeMean: Math.max(0, Number(forecast.maeMean.toFixed(2))),
      maeNaive: Math.max(0, Number(forecast.maeNaive.toFixed(2))),
      isSample: false,
      generatedAt: serverTimestamp(),
    });

    batch.set(logRef, {
      id: Number(nextAuditId),
      tenantId: tenantId.slice(0, 64),
      k: 'Forecast saved',
      m: `Saved ${forecast.windowDays}d demand forecast for ${forecast.productName} (${forecast.predictedDailyDemand.toFixed(1)}/day)`.slice(
        0,
        200
      ),
      d: todayStr.slice(0, 10),
      actorEmail: (userEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: userRole,
      severity: 'INFO',
      n: Number(nextAuditId),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function markNotificationReadInFirestore(
  tenantId: string,
  notificationId: string
): Promise<void> {
  const path = `tenants/${tenantId}/notifications/${notificationId}`;
  try {
    await updateDoc(doc(db, 'tenants', tenantId, 'notifications', notificationId), {
      read: true,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteNotificationFromFirestore(
  tenantId: string,
  notificationId: string
): Promise<void> {
  const path = `tenants/${tenantId}/notifications/${notificationId}`;
  try {
    await deleteDoc(doc(db, 'tenants', tenantId, 'notifications', notificationId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveReportToFirestore(params: {
  tenantId: string;
  reportType: 'CSV_RECOMMENDATIONS' | 'JSON_EXECUTIVE_SUMMARY';
  dateRange: string;
  summary: string;
  totalProducts: number;
  inventoryValue: number;
  belowRopCount: number;
  generatedBy: string;
}): Promise<void> {
  const {
    tenantId,
    reportType,
    dateRange,
    summary,
    totalProducts,
    inventoryValue,
    belowRopCount,
    generatedBy,
  } = params;
  const reportId = `rep-${Date.now()}`;
  const path = `tenants/${tenantId}/reports/${reportId}`;
  try {
    await setDoc(doc(db, 'tenants', tenantId, 'reports', reportId), {
      id: reportId,
      tenantId: tenantId.slice(0, 64),
      reportType,
      dateRange: dateRange.slice(0, 40),
      summary: summary.slice(0, 200),
      totalProducts: Math.max(0, Number(totalProducts)),
      inventoryValue: Math.max(0, Math.round(Number(inventoryValue))),
      belowRopCount: Math.max(0, Number(belowRopCount)),
      generatedBy: (generatedBy || 'authenticated@supplychain.io').slice(0, 120),
      generatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteReportFromFirestore(
  tenantId: string,
  reportId: string
): Promise<void> {
  const path = `tenants/${tenantId}/reports/${reportId}`;
  try {
    await deleteDoc(doc(db, 'tenants', tenantId, 'reports', reportId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function persistAuditLogToFirestore(
  tenantId: string,
  log: AuditLogEntry
): Promise<void> {
  const path = `tenants/${tenantId}/auditLogs/${log.id}`;
  try {
    await setDoc(doc(db, 'tenants', tenantId, 'auditLogs', String(log.id)), {
      id: Number(log.id),
      tenantId: tenantId.slice(0, 64),
      k: log.k.slice(0, 40),
      m: log.m.slice(0, 200),
      d: log.d.slice(0, 10),
      actorEmail: (log.actorEmail || 'authenticated@supplychain.io').slice(0, 120),
      actorRole: log.actorRole,
      severity: log.severity,
      n: Number(log.n),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function persistNewTenantToFirestore(
  uid: string,
  userEmail: string,
  _tenant: Tenant,
  state: TenantDataState
): Promise<void> {
  await ensureTenantSeededInFirestore(uid, userEmail, state);
}

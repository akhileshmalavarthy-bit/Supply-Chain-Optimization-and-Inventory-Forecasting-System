import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  Tenant,
  TenantDataState,
  Product,
  InventoryTransaction,
  PurchaseOrder,
  AuditLogEntry,
  UserRole,
} from '../types';

export async function ensureUserProfileInFirestore(
  uid: string,
  name: string,
  role: UserRole,
  activeTenantId: string
): Promise<void> {
  const userPath = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: uid.slice(0, 128),
        name: (name || 'Workspace User').slice(0, 80),
        role,
        activeTenantId: activeTenantId.slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function ensureTenantSeededInFirestore(
  uid: string,
  seedState: TenantDataState
): Promise<void> {
  const tenantId = seedState.tenant.id;
  const tenantPath = `tenants/${tenantId}`;
  try {
    const tenantRef = doc(db, 'tenants', tenantId);
    const snap = await getDoc(tenantRef);
    if (snap.exists()) {
      return;
    }

    // 1. Create parent TenantWorkspaceDoc first so Master Gate rules succeed on subcollections
    await setDoc(tenantRef, {
      id: tenantId.slice(0, 64),
      ownerId: uid.slice(0, 128),
      name: seedState.tenant.name.slice(0, 80),
      code: seedState.tenant.code.slice(0, 20),
      region: seedState.tenant.region.slice(0, 60),
      currencySymbol: seedState.tenant.currencySymbol.slice(0, 5),
      currencyLocale: seedState.tenant.currencyLocale.slice(0, 16),
      today: seedState.today.slice(0, 10),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // 2. Seed subcollections in a batch
    const batch = writeBatch(db);

    for (const p of seedState.products) {
      const pRef = doc(db, 'tenants', tenantId, 'products', String(p.id));
      batch.set(pRef, {
        id: Number(p.id),
        tenantId: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        sku: p.sku.slice(0, 20),
        name: p.name.slice(0, 60),
        cost: Math.max(0, Number(p.cost)),
        lead: Math.min(365, Math.max(0, Number(p.lead))),
        opening: Math.max(0, Number(p.opening)),
        safety: Math.max(0, Number(p.safety)),
        rop: Math.max(0, Number(p.rop)),
        base: Math.max(0, Number(p.base)),
        sup: Math.max(1, Number(p.sup)),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    for (const tx of seedState.transactions) {
      const txRef = doc(db, 'tenants', tenantId, 'transactions', String(tx.id));
      batch.set(txRef, {
        id: Number(tx.id),
        tenantId: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        pid: Number(tx.pid),
        date: tx.date.slice(0, 10),
        type: tx.type,
        qty: Number(tx.qty),
        note: (tx.note || '-').slice(0, 120),
        createdAt: serverTimestamp(),
      });
    }

    for (const po of seedState.purchaseOrders) {
      const poRef = doc(db, 'tenants', tenantId, 'purchaseOrders', po.id);
      batch.set(poRef, {
        id: po.id.slice(0, 32),
        tenantId: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        sup: Number(po.sup),
        pid: Number(po.pid),
        qty: Math.max(1, Number(po.qty)),
        od: po.od.slice(0, 10),
        ex: po.ex.slice(0, 10),
        rc: po.rc ? po.rc.slice(0, 10) : '',
        st: po.st,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    for (const log of seedState.auditLogs) {
      const logRef = doc(db, 'tenants', tenantId, 'auditLogs', String(log.id));
      batch.set(logRef, {
        id: Number(log.id),
        tenantId: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        k: log.k.slice(0, 40),
        m: log.m.slice(0, 200),
        d: log.d.slice(0, 10),
        actorRole: log.actorRole,
        severity: log.severity,
        n: Number(log.n),
        createdAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, tenantPath);
  }
}

export function subscribeToTenantCollections(
  uid: string,
  tenantId: string,
  userEmail: string,
  callbacks: {
    onProducts: (products: Product[]) => void;
    onTransactions: (transactions: InventoryTransaction[]) => void;
    onPurchaseOrders: (pos: PurchaseOrder[]) => void;
    onAuditLogs: (logs: AuditLogEntry[]) => void;
  }
): () => void {
  const productsPath = `tenants/${tenantId}/products`;
  const txPath = `tenants/${tenantId}/transactions`;
  const poPath = `tenants/${tenantId}/purchaseOrders`;
  const logsPath = `tenants/${tenantId}/auditLogs`;

  const unsubProducts = onSnapshot(
    query(collection(db, productsPath), where('ownerId', '==', uid)),
    (snap) => {
      if (snap.empty) return;
      const items: Product[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: Number(data.id),
            tenantId: String(data.tenantId),
            sku: String(data.sku),
            name: String(data.name),
            cost: Number(data.cost),
            lead: Number(data.lead),
            opening: Number(data.opening),
            safety: Number(data.safety),
            rop: Number(data.rop),
            base: Number(data.base),
            sup: Number(data.sup),
          };
        })
        .sort((a, b) => a.id - b.id);
      callbacks.onProducts(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, productsPath)
  );

  const unsubTx = onSnapshot(
    query(collection(db, txPath), where('ownerId', '==', uid)),
    (snap) => {
      if (snap.empty) return;
      const items: InventoryTransaction[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: Number(data.id),
            tenantId: String(data.tenantId),
            pid: Number(data.pid),
            date: String(data.date),
            type: data.type as 'IN' | 'OUT' | 'ADJUST',
            qty: Number(data.qty),
            note: String(data.note),
            actorName: userEmail,
          };
        })
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
      callbacks.onTransactions(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, txPath)
  );

  const unsubPo = onSnapshot(
    query(collection(db, poPath), where('ownerId', '==', uid)),
    (snap) => {
      if (snap.empty) return;
      const items: PurchaseOrder[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id),
            tenantId: String(data.tenantId),
            sup: Number(data.sup),
            pid: Number(data.pid),
            qty: Number(data.qty),
            od: String(data.od),
            ex: String(data.ex),
            rc: data.rc ? String(data.rc) : null,
            st: data.st as 'pending' | 'received' | 'cancelled',
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      callbacks.onPurchaseOrders(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, poPath)
  );

  const unsubLogs = onSnapshot(
    query(collection(db, logsPath), where('ownerId', '==', uid)),
    (snap) => {
      if (snap.empty) return;
      const items: AuditLogEntry[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: Number(data.id),
            tenantId: String(data.tenantId),
            k: String(data.k),
            m: String(data.m),
            d: String(data.d),
            timestamp: new Date().toISOString(),
            actorEmail: userEmail,
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
    unsubTx();
    unsubPo();
    unsubLogs();
  };
}

export async function persistProductToFirestore(
  uid: string,
  tenantId: string,
  product: Product,
  isNew: boolean
): Promise<void> {
  const path = `tenants/${tenantId}/products/${product.id}`;
  const ref = doc(db, 'tenants', tenantId, 'products', String(product.id));
  try {
    if (isNew) {
      await setDoc(ref, {
        id: Number(product.id),
        tenantId: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        sku: product.sku.slice(0, 20),
        name: product.name.slice(0, 60),
        cost: Math.max(0, Number(product.cost)),
        lead: Math.min(365, Math.max(0, Number(product.lead))),
        opening: Math.max(0, Number(product.opening)),
        safety: Math.max(0, Number(product.safety)),
        rop: Math.max(0, Number(product.rop)),
        base: Math.max(0, Number(product.base)),
        sup: Math.max(1, Number(product.sup)),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        sku: product.sku.slice(0, 20),
        name: product.name.slice(0, 60),
        cost: Math.max(0, Number(product.cost)),
        lead: Math.min(365, Math.max(0, Number(product.lead))),
        opening: Math.max(0, Number(product.opening)),
        safety: Math.max(0, Number(product.safety)),
        rop: Math.max(0, Number(product.rop)),
        sup: Math.max(1, Number(product.sup)),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deleteProductFromFirestore(
  tenantId: string,
  productId: number,
  relatedTxIds: number[]
): Promise<void> {
  const path = `tenants/${tenantId}/products/${productId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'tenants', tenantId, 'products', String(productId)));
    for (const txId of relatedTxIds) {
      batch.delete(doc(db, 'tenants', tenantId, 'transactions', String(txId)));
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function persistTransactionToFirestore(
  uid: string,
  tenantId: string,
  tx: InventoryTransaction
): Promise<void> {
  const path = `tenants/${tenantId}/transactions/${tx.id}`;
  try {
    await setDoc(doc(db, 'tenants', tenantId, 'transactions', String(tx.id)), {
      id: Number(tx.id),
      tenantId: tenantId.slice(0, 64),
      ownerId: uid.slice(0, 128),
      pid: Number(tx.pid),
      date: tx.date.slice(0, 10),
      type: tx.type,
      qty: Number(tx.qty),
      note: (tx.note || '-').slice(0, 120),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function persistPurchaseOrderToFirestore(
  uid: string,
  tenantId: string,
  po: PurchaseOrder,
  isNew: boolean
): Promise<void> {
  const path = `tenants/${tenantId}/purchaseOrders/${po.id}`;
  const ref = doc(db, 'tenants', tenantId, 'purchaseOrders', po.id);
  try {
    if (isNew) {
      await setDoc(ref, {
        id: po.id.slice(0, 32),
        tenantId: tenantId.slice(0, 64),
        ownerId: uid.slice(0, 128),
        sup: Number(po.sup),
        pid: Number(po.pid),
        qty: Math.max(1, Number(po.qty)),
        od: po.od.slice(0, 10),
        ex: po.ex.slice(0, 10),
        rc: po.rc ? po.rc.slice(0, 10) : '',
        st: po.st,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        rc: po.rc ? po.rc.slice(0, 10) : '',
        st: po.st,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function persistAuditLogToFirestore(
  uid: string,
  tenantId: string,
  log: AuditLogEntry
): Promise<void> {
  const path = `tenants/${tenantId}/auditLogs/${log.id}`;
  try {
    await setDoc(doc(db, 'tenants', tenantId, 'auditLogs', String(log.id)), {
      id: Number(log.id),
      tenantId: tenantId.slice(0, 64),
      ownerId: uid.slice(0, 128),
      k: log.k.slice(0, 40),
      m: log.m.slice(0, 200),
      d: log.d.slice(0, 10),
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
  tenant: Tenant,
  state: TenantDataState
): Promise<void> {
  await ensureTenantSeededInFirestore(uid, state);
}

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import {
  Tenant,
  UserProfile,
  UserRole,
  TenantDataState,
  Supplier,
  Product,
  InventoryTransaction,
  PurchaseOrder,
  AuditLogEntry,
  PresenceClient,
} from './src/types';

dotenv.config();

const PORT = 3000;

// Deterministic PRNG matching the prototype's Mulberry32 seed=42
function createSeededRandom(initialSeed: number) {
  let seed = initialSeed | 0;
  return function R() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ds(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function add(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sum(a: number[]): number {
  return a.reduce((x, y) => x + y, 0);
}

interface RuntimeDatabase {
  tenants: Tenant[];
  users: UserProfile[];
  tenantStates: Record<string, TenantDataState>;
}

function buildTenantSeedData(tenant: Tenant, seedVal: number, costMultiplier = 1): TenantDataState {
  const R = createSeededRandom(seedVal);
  const TODAY = new Date(2026, 9, 27);
  const DAYS = 90;
  const TD = ds(TODAY);
  const DATES: string[] = [];
  for (let i = 0; i < DAYS; i++) {
    DATES.push(ds(add(TODAY, i - DAYS + 1)));
  }

  const SUP: Supplier[] = [
    { id: 1, tenantId: tenant.id, name: 'TechSource India Pvt Ltd' },
    { id: 2, tenantId: tenant.id, name: 'Accessory World' },
    { id: 3, tenantId: tenant.id, name: 'StorageHub Traders' },
    { id: 4, tenantId: tenant.id, name: 'AudioVision Supplies' },
    { id: 5, tenantId: tenant.id, name: 'NetLink Distributors' },
  ];

  const rawProducts: [number, string, string, number, number, number, number, number, number][] = [
    [1, 'LAP-001', 'Laptop', Math.round(50000 * costMultiplier), 5, 40, 20, 10, 1],
    [2, 'MOU-001', 'Mouse', Math.round(500 * costMultiplier), 3, 300, 50, 40, 2],
    [3, 'KEY-001', 'Keyboard', Math.round(1500 * costMultiplier), 4, 55, 30, 15, 2],
    [4, 'MON-001', 'Monitor', Math.round(12000 * costMultiplier), 7, 90, 10, 4, 1],
    [5, 'HDD-001', 'External HDD', Math.round(4500 * costMultiplier), 6, 0, 15, 7, 3],
    [6, 'WEB-001', 'Webcam', Math.round(2500 * costMultiplier), 4, 400, 10, 5, 4],
    [7, 'HDP-001', 'Headphones', Math.round(1800 * costMultiplier), 5, 48, 20, 8, 4],
    [8, 'PRN-001', 'Printer', Math.round(9000 * costMultiplier), 8, 60, 8, 2, 3],
    [9, 'CBL-001', 'USB Cable', Math.round(150 * costMultiplier), 2, 3000, 40, 35, 2],
    [10, 'RTR-001', 'Router', Math.round(3200 * costMultiplier), 6, 22, 10, 4, 5],
  ];

  const DEM: Record<number, number[]> = {};
  const TX: InventoryTransaction[] = [];
  const PO: PurchaseOrder[] = [];
  const ACT: AuditLogEntry[] = [];
  let seq = 1;

  const P: Product[] = rawProducts
    .map((a) => ({
      id: a[0],
      tenantId: tenant.id,
      sku: a[1],
      name: a[2],
      cost: a[3],
      lead: a[4],
      opening: 0,
      safety: a[6],
      rop: 0,
      base: a[7],
      sup: a[8],
      _targetSt: a[5],
    }))
    .map((item) => {
      const targetSt = (item as unknown as { _targetSt: number })._targetSt;
      const a: number[] = [];
      for (let i = 0; i < DAYS; i++) {
        a.push(
          Math.max(
            0,
            Math.round(
              item.base *
                (1 + 0.2 * Math.sin((i * 2 * Math.PI) / 7)) *
                (1 + (0.1 * i) / DAYS) *
                (0.85 + 0.3 * R())
            )
          )
        );
      }
      DEM[item.id] = a;

      let s = 0;
      const n = 3 + Math.floor(R() * 3);
      for (let k = 0; k < n; k++) {
        const inn = R() < 0.45;
        const q = Math.max(1, Math.round(item.base * (inn ? 4 + R() * 4 : 1 + R() * 3)));
        TX.push({
          id: 0,
          tenantId: tenant.id,
          pid: item.id,
          date: ds(add(TODAY, -Math.floor(R() * 25))),
          type: inn ? 'IN' : 'OUT',
          qty: inn ? q : -q,
          note: inn ? 'Supplier delivery (verified)' : 'Customer order fulfillment',
          actorName: 'ops.automation@supplychain.io',
        });
        s += inn ? q : -q;
      }

      let o = targetSt - s;
      if (o < 0) {
        o = 0;
        TX.push({
          id: 0,
          tenantId: tenant.id,
          pid: item.id,
          date: ds(add(TODAY, -1)),
          type: 'ADJUST',
          qty: targetSt - s,
          note: 'Cycle count correction',
          actorName: 'auditor@supplychain.io',
        });
      }

      const avgD30 = sum(a.slice(-30)) / 30;
      const rop = Math.round(avgD30 * item.lead + item.safety);

      return {
        id: item.id,
        tenantId: tenant.id,
        sku: item.sku,
        name: item.name,
        cost: item.cost,
        lead: item.lead,
        opening: o,
        safety: item.safety,
        rop,
        base: item.base,
        sup: item.sup,
      };
    });

  TX.sort((a, b) => (a.date < b.date ? -1 : 1));
  TX.forEach((t, i) => {
    t.id = i + 1;
  });

  for (let i = 0; i < 14; i++) {
    const s = (i % 5) + 1;
    const ps = P.filter((p) => p.sup === s);
    const p = ps[i % ps.length];
    const pend = i >= 12;
    const ago = pend ? i - 11 : 6 + (11 - i) * 6;
    const od = add(TODAY, -ago);
    const ex = add(od, p.lead);
    const stt = i === 5 ? 'cancelled' : pend ? 'pending' : 'received';
    const rc = stt === 'received' ? add(ex, Math.floor(R() * 6) - 1) : null;
    PO.push({
      id: 'PO-' + (1000 + i),
      tenantId: tenant.id,
      sup: s,
      pid: p.id,
      qty: p.base * 10,
      od: ds(od),
      ex: ds(ex),
      rc: rc ? ds(rc) : null,
      st: stt,
    });
  }

  function act(
    k: string,
    m: string,
    d?: string,
    severity: 'INFO' | 'WARN' | 'CRITICAL' = 'INFO',
    actorEmail = 'akhileshmalavarthy@gmail.com',
    actorRole: UserRole = 'SUPER_ADMIN'
  ) {
    const num = seq++;
    ACT.push({
      id: num,
      tenantId: tenant.id,
      k,
      m,
      d: d || TD,
      timestamp: new Date().toISOString(),
      actorEmail,
      actorRole,
      ip: 'Firestore-Cloud',
      severity,
      n: num,
    });
  }

  P.slice(-2).forEach((p) => {
    act('Product added', `${p.name} (${p.sku}) added to catalogue`, ds(add(TODAY, -40)), 'INFO');
  });
  PO.filter((x) => x.rc)
    .slice(-3)
    .forEach((x) => {
      act('Purchase order', `${x.id} received`, x.rc || TD, 'INFO', 'ops.manager@supplychain.io', 'OPS_MANAGER');
    });
  PO.filter((x) => x.st === 'pending').forEach((x) => {
    act('Purchase order', `${x.id} pending, expected ${x.ex}`, x.od, 'WARN', 'ops.manager@supplychain.io', 'OPS_MANAGER');
  });
  TX.slice(-6).forEach((t) => {
    const p = P.find((q) => q.id === t.pid);
    if (p) {
      act(
        'Stock ' + t.type,
        `${t.type} ${Math.abs(t.qty)} × ${p.name}`,
        t.date,
        t.type === 'ADJUST' ? 'WARN' : 'INFO',
        'inventory.analyst@supplychain.io',
        'INVENTORY_ANALYST'
      );
    }
  });
  act('Firestore Ready', `Cloud Firestore persistence configured for ${tenant.name}`, TD, 'INFO');

  return {
    tenant,
    today: TD,
    dates: DATES,
    suppliers: SUP,
    products: P,
    demand: DEM,
    transactions: TX,
    purchaseOrders: PO,
    auditLogs: ACT,
  };
}

function initializeRuntimeState(): RuntimeDatabase {
  const tenants: Tenant[] = [
    {
      id: 'tenant-in-01',
      name: 'Apex Supply Chain India (Primary)',
      code: 'APX-IN',
      region: 'Asia-South (Mumbai)',
      currencySymbol: '₹',
      currencyLocale: 'en-IN',
      status: 'ACTIVE',
      createdAt: '2026-01-15',
    },
    {
      id: 'tenant-eu-02',
      name: 'EuroLogix Distribution GmbH',
      code: 'ELX-EU',
      region: 'EU-Central (Frankfurt)',
      currencySymbol: '€',
      currencyLocale: 'de-DE',
      status: 'ACTIVE',
      createdAt: '2026-03-10',
    },
    {
      id: 'tenant-us-03',
      name: 'Pacific Freight & Warehousing',
      code: 'PFW-US',
      region: 'US-West (Oregon)',
      currencySymbol: '$',
      currencyLocale: 'en-US',
      status: 'ACTIVE',
      createdAt: '2026-05-22',
    },
  ];

  const users: UserProfile[] = [
    {
      id: 'usr-admin-01',
      name: 'Akhilesh Malavarthy',
      email: 'akhileshmalavarthy@gmail.com',
      role: 'SUPER_ADMIN',
      tenantIds: ['tenant-in-01', 'tenant-eu-02', 'tenant-us-03'],
      oauthProvider: 'google-oauth2',
      mfaEnabled: true,
      lastActive: new Date().toISOString(),
    },
    {
      id: 'usr-ops-02',
      name: 'Priya Sharma (Ops Manager)',
      email: 'priya.ops@supplychain.io',
      role: 'OPS_MANAGER',
      tenantIds: ['tenant-in-01', 'tenant-eu-02'],
      oauthProvider: 'google-oauth2',
      mfaEnabled: true,
      lastActive: new Date().toISOString(),
    },
    {
      id: 'usr-ana-03',
      name: 'Rohan Verma (Inventory Analyst)',
      email: 'rohan.analyst@supplychain.io',
      role: 'INVENTORY_ANALYST',
      tenantIds: ['tenant-in-01'],
      oauthProvider: 'enterprise-oidc',
      mfaEnabled: true,
      lastActive: new Date().toISOString(),
    },
    {
      id: 'usr-aud-04',
      name: 'Elena Rostova (Compliance Auditor)',
      email: 'elena.auditor@supplychain.io',
      role: 'AUDITOR',
      tenantIds: ['tenant-in-01', 'tenant-eu-02', 'tenant-us-03'],
      oauthProvider: 'github-oauth2',
      mfaEnabled: true,
      lastActive: new Date().toISOString(),
    },
  ];

  const tenantStates: Record<string, TenantDataState> = {
    'tenant-in-01': buildTenantSeedData(tenants[0], 42, 1),
    'tenant-eu-02': buildTenantSeedData(tenants[1], 108, 0.012),
    'tenant-us-03': buildTenantSeedData(tenants[2], 256, 0.013),
  };

  return { tenants, users, tenantStates };
}

const db: RuntimeDatabase = initializeRuntimeState();

const sessionTokens = new Map<string, { userId: string; issuedAt: number; expiresAt: number }>();
const DEFAULT_TOKEN = 'oauth2_ent_tok_akhilesh_superadmin_2026';
sessionTokens.set(DEFAULT_TOKEN, {
  userId: 'usr-admin-01',
  issuedAt: Date.now(),
  expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
});

const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  SUPER_ADMIN: [
    'products:write',
    'products:delete',
    'inventory:write',
    'po:write',
    'tenants:manage',
    'users:manage',
    'reports:export',
  ],
  OPS_MANAGER: ['products:write', 'inventory:write', 'po:write', 'reports:export'],
  INVENTORY_ANALYST: ['inventory:write', 'reports:export'],
  AUDITOR: ['reports:export'],
};

interface AuthenticatedRequest extends Request {
  user?: UserProfile;
  tenantId?: string;
  requestStartMs?: number;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  app.use(express.json({ limit: '2mb' }));

  app.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    req.requestStartMs = performance.now();
    res.on('finish', () => {
      const elapsed = (performance.now() - (req.requestStartMs || 0)).toFixed(2);
      res.locals.latencyMs = elapsed;
    });
    next();
  });

  const authenticateSession = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : DEFAULT_TOKEN;
    const session = sessionTokens.get(token) || sessionTokens.get(DEFAULT_TOKEN)!;
    const user = db.users.find((u) => u.id === session.userId) || db.users[0];
    req.user = user;

    const requestedTenant =
      (req.headers['x-tenant-id'] as string) ||
      (req.query.tenantId as string) ||
      user.tenantIds[0] ||
      'tenant-in-01';

    req.tenantId = db.tenantStates[requestedTenant] ? requestedTenant : 'tenant-in-01';
    next();
  };

  const requirePermission = (permission: string) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: 'Unauthenticated session.' });
        return;
      }
      const allowed = ROLE_PERMISSIONS[user.role] || [];
      if (!allowed.includes(permission)) {
        const tenantId = req.tenantId || 'tenant-in-01';
        const auditLog = appendAuditLog(
          tenantId,
          'RBAC Denied',
          `Blocked ${user.role} (${user.email}) from executing '${permission}'`,
          'CRITICAL',
          user.email,
          user.role
        );
        broadcastToTenant(tenantId, {
          type: 'state:sync',
          tenantId,
          state: db.tenantStates[tenantId],
        });
        res.status(403).json({
          error: `RBAC Policy Violation: Role '${user.role}' does not have '${permission}' permission.`,
          auditLog,
        });
        return;
      }
      next();
    };
  };

  const clients = new Map<WebSocket, PresenceClient>();

  function broadcastPresence() {
    const allPresence = Array.from(clients.values());
    const msg = JSON.stringify({ type: 'presence:update', clients: allPresence });
    for (const [ws] of clients.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  function broadcastToTenant(tenantId: string, payload: Record<string, unknown>) {
    const msg = JSON.stringify(payload);
    for (const [ws, meta] of clients.entries()) {
      if (
        ws.readyState === WebSocket.OPEN &&
        (meta.tenantId === tenantId || payload.type === 'tenant:created')
      ) {
        ws.send(msg);
      }
    }
  }

  function appendAuditLog(
    tenantId: string,
    category: string,
    message: string,
    severity: 'INFO' | 'WARN' | 'CRITICAL',
    actorEmail: string,
    actorRole: UserRole,
    customDate?: string
  ): AuditLogEntry {
    const state = db.tenantStates[tenantId];
    const nextN = state.auditLogs.reduce((max, item) => Math.max(max, item.n), 0) + 1;
    const entry: AuditLogEntry = {
      id: nextN,
      tenantId,
      k: category,
      m: message,
      d: customDate || state.today,
      timestamp: new Date().toISOString(),
      actorEmail,
      actorRole,
      ip: 'Firestore-Cloud',
      severity,
      n: nextN,
    };
    state.auditLogs.push(entry);
    return entry;
  }

  wss.on('connection', (ws: WebSocket) => {
    const clientId = 'ws-' + crypto.randomBytes(4).toString('hex');
    const defaultUser = db.users[0];
    clients.set(ws, {
      clientId,
      userName: defaultUser.name,
      userEmail: defaultUser.email,
      role: defaultUser.role,
      tenantId: 'tenant-in-01',
      connectedAt: new Date().toISOString(),
    });
    broadcastPresence();

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data.type === 'client:identify') {
          const current = clients.get(ws);
          if (current) {
            clients.set(ws, {
              ...current,
              userName: data.userName || current.userName,
              userEmail: data.userEmail || current.userEmail,
              role: data.role || current.role,
              tenantId: data.tenantId || current.tenantId,
            });
            broadcastPresence();
          }
        }
      } catch {
        // Ignore malformed WS payloads
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      broadcastPresence();
    });
  });

  // Sync Firestore snapshot into Express runtime state for WebSocket & API consistency
  app.post('/api/firestore/sync-tenant', authenticateSession, (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenantId || 'tenant-in-01';
    const state = db.tenantStates[tenantId];
    if (!state) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    const {
      products,
      suppliers,
      inventory,
      transactions,
      purchaseOrders,
      forecasts,
      notifications,
      reports,
      auditLogs,
    } = req.body;
    if (Array.isArray(products)) {
      state.products = products;
      for (const p of products) {
        if (!state.demand[p.id]) {
          state.demand[p.id] = state.dates.map(() => 0);
        }
      }
    }
    if (Array.isArray(suppliers)) {
      state.suppliers = suppliers;
    }
    if (Array.isArray(inventory)) {
      state.inventory = inventory;
    }
    if (Array.isArray(transactions)) {
      state.transactions = transactions;
    }
    if (Array.isArray(purchaseOrders)) {
      state.purchaseOrders = purchaseOrders;
    }
    if (Array.isArray(forecasts)) {
      state.forecasts = forecasts;
      for (const f of forecasts) {
        if (Array.isArray(f.historySeries) && f.historySeries.length > 0) {
          state.demand[f.productId] = f.historySeries;
        }
      }
    }
    if (Array.isArray(notifications)) {
      state.notifications = notifications;
    }
    if (Array.isArray(reports)) {
      state.reports = reports;
    }
    if (Array.isArray(auditLogs)) {
      state.auditLogs = auditLogs;
    }
    res.json({ ok: true, state });
  });

  app.post('/api/auth/switch-user', authenticateSession, (req: AuthenticatedRequest, res: Response) => {
    const { userId, role } = req.body;
    const tenantId = req.tenantId || 'tenant-in-01';
    const targetUser = db.users.find((u) => u.id === userId) || req.user!;

    if (role && ['SUPER_ADMIN', 'OPS_MANAGER', 'INVENTORY_ANALYST', 'AUDITOR'].includes(role)) {
      targetUser.role = role as UserRole;
    }
    targetUser.lastActive = new Date().toISOString();

    const newToken = 'oauth2_tok_' + crypto.randomBytes(10).toString('hex');
    sessionTokens.set(newToken, {
      userId: targetUser.id,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24,
    });

    const auditLog = appendAuditLog(
      tenantId,
      'RBAC Session',
      `Session switched to ${targetUser.name} [${targetUser.role}]`,
      'INFO',
      targetUser.email,
      targetUser.role
    );

    broadcastToTenant(tenantId, {
      type: 'state:sync',
      tenantId,
      state: db.tenantStates[tenantId],
    });

    res.json({
      token: newToken,
      user: targetUser,
      permissions: ROLE_PERMISSIONS[targetUser.role],
      auditLog,
    });
  });

  app.get('/api/bootstrap', authenticateSession, (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenantId || 'tenant-in-01';
    const user = req.user!;
    res.json({
      user,
      permissions: ROLE_PERMISSIONS[user.role],
      users: db.users,
      tenants: db.tenants,
      activeTenantId: tenantId,
      state: db.tenantStates[tenantId],
    });
  });

  app.get('/api/products', authenticateSession, (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenantId || 'tenant-in-01';
    const state = db.tenantStates[tenantId];
    const items = state.products.map((p) => {
      const currentStock =
        p.opening + sum(state.transactions.filter((t) => t.pid === p.id).map((t) => t.qty));
      const status =
        currentStock <= 0 ? 'Out of Stock' : currentStock <= p.rop ? 'Low Stock' : 'Healthy Stock';
      return { ...p, currentStock, status };
    });
    res.json({ products: items });
  });

  app.get('/api/analytics/forecast', authenticateSession, (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenantId || 'tenant-in-01';
    const state = db.tenantStates[tenantId];
    const windowDays = Math.max(1, Number(req.query.window) || 30);
    const horizon = 14;
    const forecasts = state.products.map((p) => {
      const series = state.demand[p.id] || [];
      const slice = series.slice(-windowDays);
      const meanDaily = slice.length > 0 ? sum(slice) / slice.length : 0;
      return {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        windowDays,
        horizonDays: horizon,
        baselineDailyForecast: Number(meanDaily.toFixed(2)),
        projected14DayTotal: Math.round(meanDaily * horizon),
      };
    });
    res.json({ tenantId, generatedOn: state.today, forecasts });
  });

  app.get('/api/recommendations', authenticateSession, (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenantId || 'tenant-in-01';
    const state = db.tenantStates[tenantId];
    const recommendations = state.products.map((p) => {
      const currentStock =
        p.opening + sum(state.transactions.filter((t) => t.pid === p.id).map((t) => t.qty));
      const series = state.demand[p.id] || [];
      const avgDaily = series.length > 0 ? sum(series.slice(-30)) / 30 : 0;
      const leadDemand = avgDaily * p.lead;
      const rop = Math.round(leadDemand + p.safety);
      const riskLevel =
        currentStock <= 0
          ? 'Out of stock (actual)'
          : currentStock <= rop
          ? 'Reorder required'
          : 'Healthy';
      return {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        currentStock,
        reorderPoint: rop,
        riskLevel,
      };
    });
    res.json({ tenantId, recommendations });
  });

  app.post(
    '/api/products',
    authenticateSession,
    requirePermission('products:write'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.tenantId!;
      const state = db.tenantStates[tenantId];
      const user = req.user!;
      const { sku, name, cost, lead, rop, stock, safe, sup } = req.body;

      const cleanSku = String(sku || '').trim();
      const cleanName = String(name || '').trim();
      const errors: string[] = [];

      if (!/^[A-Za-z0-9-]{3,20}$/.test(cleanSku)) {
        errors.push('SKU must be 3-20 letters, digits or hyphens.');
      } else if (state.products.some((p) => p.sku.toLowerCase() === cleanSku.toLowerCase())) {
        errors.push('Duplicate SKU: this SKU already exists.');
      }
      if (!cleanName || cleanName.length > 60) {
        errors.push('Product name is required (max 60 characters).');
      }
      if (cost === '' || isNaN(+cost) || +cost < 0) {
        errors.push('Unit cost must be a number of 0 or more (negative prices are rejected).');
      }
      const isWhole = (v: unknown, mx: number) =>
        String(v).trim() !== '' && Number.isInteger(+v!) && +v! >= 0 && +v! <= mx;

      if (!isWhole(lead, 365)) errors.push('Lead time must be a whole number of days (0-365).');
      if (!isWhole(rop, 1e6)) errors.push('Reorder point must be a whole number of 0 or more.');
      if (!isWhole(stock, 1e7)) errors.push('Current stock must be a whole number of 0 or more.');
      if (!isWhole(safe, 1e6)) errors.push('Safety stock must be a whole number of 0 or more.');

      if (errors.length > 0) {
        res.status(400).json({ errors });
        return;
      }

      const nextId = state.products.reduce((max, x) => Math.max(max, x.id), 0) + 1;
      const newProduct: Product = {
        id: nextId,
        tenantId,
        sku: cleanSku,
        name: cleanName,
        cost: +cost,
        lead: +lead,
        rop: +rop,
        safety: +safe,
        sup: +sup || 1,
        opening: +stock,
        base: 0,
      };

      state.products.push(newProduct);
      state.demand[nextId] = state.dates.map(() => 0);

      const auditLog = appendAuditLog(
        tenantId,
        'Product added',
        `${cleanName} (${cleanSku}) added`,
        'INFO',
        user.email,
        user.role
      );

      broadcastToTenant(tenantId, {
        type: 'state:sync',
        tenantId,
        state,
      });

      res.json({ product: newProduct, auditLog, state });
    }
  );

  app.put(
    '/api/products/:id',
    authenticateSession,
    requirePermission('products:write'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.tenantId!;
      const state = db.tenantStates[tenantId];
      const user = req.user!;
      const id = Number(req.params.id);
      const existing = state.products.find((x) => x.id === id);
      if (!existing) {
        res.status(404).json({ errors: ['Product not found.'] });
        return;
      }

      const { sku, name, cost, lead, rop, stock, safe, sup } = req.body;
      const cleanSku = String(sku || '').trim();
      const cleanName = String(name || '').trim();
      const errors: string[] = [];

      if (!/^[A-Za-z0-9-]{3,20}$/.test(cleanSku)) {
        errors.push('SKU must be 3-20 letters, digits or hyphens.');
      } else if (
        state.products.some((p) => p.id !== id && p.sku.toLowerCase() === cleanSku.toLowerCase())
      ) {
        errors.push('Duplicate SKU: this SKU already exists.');
      }
      if (!cleanName || cleanName.length > 60) {
        errors.push('Product name is required (max 60 characters).');
      }
      if (cost === '' || isNaN(+cost) || +cost < 0) {
        errors.push('Unit cost must be a number of 0 or more (negative prices are rejected).');
      }
      const isWhole = (v: unknown, mx: number) =>
        String(v).trim() !== '' && Number.isInteger(+v!) && +v! >= 0 && +v! <= mx;

      if (!isWhole(lead, 365)) errors.push('Lead time must be a whole number of days (0-365).');
      if (!isWhole(rop, 1e6)) errors.push('Reorder point must be a whole number of 0 or more.');
      if (!isWhole(stock, 1e7)) errors.push('Current stock must be a whole number of 0 or more.');
      if (!isWhole(safe, 1e6)) errors.push('Safety stock must be a whole number of 0 or more.');

      if (errors.length > 0) {
        res.status(400).json({ errors });
        return;
      }

      const currentLedgerStock =
        existing.opening +
        sum(state.transactions.filter((t) => t.pid === existing.id).map((t) => t.qty));

      existing.opening = Math.max(0, existing.opening + (+stock - currentLedgerStock));
      existing.sku = cleanSku;
      existing.name = cleanName;
      existing.cost = +cost;
      existing.lead = +lead;
      existing.rop = +rop;
      existing.safety = +safe;
      existing.sup = +sup || existing.sup;

      const auditLog = appendAuditLog(
        tenantId,
        'Product updated',
        `${existing.name} (${existing.sku}) updated`,
        'INFO',
        user.email,
        user.role
      );

      broadcastToTenant(tenantId, {
        type: 'state:sync',
        tenantId,
        state,
      });

      res.json({ product: existing, auditLog, state });
    }
  );

  app.delete(
    '/api/products/:id',
    authenticateSession,
    requirePermission('products:delete'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.tenantId!;
      const state = db.tenantStates[tenantId];
      const user = req.user!;
      const id = Number(req.params.id);
      const existing = state.products.find((x) => x.id === id);
      if (!existing) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      const deletedTxIds = state.transactions.filter((t) => t.pid === id).map((t) => t.id);
      state.products = state.products.filter((x) => x.id !== id);
      state.transactions = state.transactions.filter((t) => t.pid !== id);

      const auditLog = appendAuditLog(
        tenantId,
        'Product removed',
        `${existing.name} (${existing.sku}) deleted`,
        'WARN',
        user.email,
        user.role
      );

      broadcastToTenant(tenantId, {
        type: 'state:sync',
        tenantId,
        state,
      });

      res.json({ deletedTxIds, auditLog, state });
    }
  );

  app.post(
    '/api/transactions',
    authenticateSession,
    requirePermission('inventory:write'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.tenantId!;
      const state = db.tenantStates[tenantId];
      const user = req.user!;
      const { pid, type, qty, date, note } = req.body;

      const product = state.products.find((p) => p.id === Number(pid));
      const q = Number(qty);
      const txType = String(type) as 'IN' | 'OUT' | 'ADJUST';

      if (
        !product ||
        qty === '' ||
        qty === null ||
        !Number.isInteger(q) ||
        q === 0 ||
        (txType !== 'ADJUST' && q < 0)
      ) {
        res.status(400).json({ error: 'Enter a valid whole-number quantity.' });
        return;
      }

      const currentStock =
        product.opening +
        sum(state.transactions.filter((t) => t.pid === product.id).map((t) => t.qty));

      const delta = txType === 'IN' ? q : txType === 'OUT' ? -q : q;
      if (currentStock + delta < 0) {
        res.status(400).json({
          error: `Rejected: stock cannot go negative (available ${currentStock} units).`,
        });
        return;
      }

      const nextTxId = state.transactions.reduce((max, x) => Math.max(max, x.id), 0) + 1;
      const dt = date || state.today;
      const cleanNote = String(note || '')
        .trim()
        .slice(0, 120) || '-';

      const tx: InventoryTransaction = {
        id: nextTxId,
        tenantId,
        pid: product.id,
        date: dt,
        type: txType,
        qty: delta,
        note: cleanNote,
        actorName: user.email,
      };

      state.transactions.push(tx);
      const auditLog = appendAuditLog(
        tenantId,
        'Stock ' + txType,
        `${txType} ${Math.abs(delta)} × ${product.name}`,
        txType === 'ADJUST' ? 'WARN' : 'INFO',
        user.email,
        user.role,
        dt
      );

      broadcastToTenant(tenantId, {
        type: 'state:sync',
        tenantId,
        state,
      });

      const newStock = currentStock + delta;
      res.json({ transaction: tx, auditLog, newStock, state });
    }
  );

  app.post(
    '/api/purchase-orders',
    authenticateSession,
    requirePermission('po:write'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.tenantId!;
      const state = db.tenantStates[tenantId];
      const user = req.user!;
      const { pid, qty } = req.body;

      const product = state.products.find((p) => p.id === Number(pid));
      const orderQty = Math.max(1, Math.round(Number(qty) || 10));
      if (!product) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }

      const nextPoNum = 1000 + state.purchaseOrders.length + 1;
      const od = state.today;
      const ex = ds(add(new Date(od + 'T00:00:00'), product.lead));
      const po: PurchaseOrder = {
        id: `PO-${nextPoNum}`,
        tenantId,
        sup: product.sup,
        pid: product.id,
        qty: orderQty,
        od,
        ex,
        rc: null,
        st: 'pending',
      };

      state.purchaseOrders.push(po);
      const auditLog = appendAuditLog(
        tenantId,
        'Purchase order',
        `${po.id} created (${orderQty} × ${product.name}), expected ${po.ex}`,
        'INFO',
        user.email,
        user.role
      );

      broadcastToTenant(tenantId, {
        type: 'state:sync',
        tenantId,
        state,
      });

      res.json({ purchaseOrder: po, auditLog, state });
    }
  );

  app.patch(
    '/api/purchase-orders/:id',
    authenticateSession,
    requirePermission('po:write'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.tenantId!;
      const state = db.tenantStates[tenantId];
      const user = req.user!;
      const po = state.purchaseOrders.find((x) => x.id === req.params.id);
      if (!po) {
        res.status(404).json({ error: 'Purchase order not found' });
        return;
      }

      const { status } = req.body;
      let createdTransaction: InventoryTransaction | null = null;
      let auditLog: AuditLogEntry | null = null;

      if (status === 'received' && po.st !== 'received') {
        po.st = 'received';
        po.rc = state.today;
        const product = state.products.find((p) => p.id === po.pid);
        if (product) {
          const nextTxId = state.transactions.reduce((max, x) => Math.max(max, x.id), 0) + 1;
          createdTransaction = {
            id: nextTxId,
            tenantId,
            pid: product.id,
            date: state.today,
            type: 'IN',
            qty: po.qty,
            note: `PO receipt ${po.id}`,
            actorName: user.email,
          };
          state.transactions.push(createdTransaction);
        }
        auditLog = appendAuditLog(
          tenantId,
          'Purchase order',
          `${po.id} received (+${po.qty} units credited to ledger)`,
          'INFO',
          user.email,
          user.role
        );
      } else if (status === 'cancelled') {
        po.st = 'cancelled';
        auditLog = appendAuditLog(
          tenantId,
          'Purchase order',
          `${po.id} cancelled`,
          'WARN',
          user.email,
          user.role
        );
      }

      broadcastToTenant(tenantId, {
        type: 'state:sync',
        tenantId,
        state,
      });

      res.json({ purchaseOrder: po, createdTransaction, auditLog, state });
    }
  );

  app.post(
    '/api/tenants',
    authenticateSession,
    requirePermission('tenants:manage'),
    (req: AuthenticatedRequest, res: Response) => {
      const user = req.user!;
      const { name, code, region, currencySymbol } = req.body;
      const cleanName = String(name || '').trim();
      const cleanCode = String(code || '').trim().toUpperCase();

      if (!cleanName || !cleanCode) {
        res.status(400).json({ error: 'Tenant name and code are required.' });
        return;
      }

      const newId =
        'tenant-' +
        cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '') +
        '-' +
        (db.tenants.length + 1);
      const newTenant: Tenant = {
        id: newId,
        name: cleanName,
        code: cleanCode,
        region: String(region || 'Global Edge'),
        currencySymbol: String(currencySymbol || '₹'),
        currencyLocale:
          currencySymbol === '$' ? 'en-US' : currencySymbol === '€' ? 'de-DE' : 'en-IN',
        status: 'ACTIVE',
        createdAt: ds(new Date()),
      };

      db.tenants.push(newTenant);
      db.tenantStates[newId] = buildTenantSeedData(
        newTenant,
        Math.floor(Math.random() * 500) + 50,
        currencySymbol === '$' || currencySymbol === '€' ? 0.015 : 1
      );

      db.users.forEach((u) => {
        if (u.role === 'SUPER_ADMIN' || u.role === 'AUDITOR') {
          u.tenantIds.push(newId);
        }
      });

      appendAuditLog(
        newId,
        'Tenant Provisioned',
        `Multi-tenant workspace '${cleanName}' (${cleanCode}) initialized`,
        'INFO',
        user.email,
        user.role
      );

      broadcastToTenant(newId, {
        type: 'tenant:created',
        tenants: db.tenants,
        activeTenantId: newId,
        state: db.tenantStates[newId],
      });

      res.json({ tenant: newTenant, tenants: db.tenants, state: db.tenantStates[newId] });
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SupplyChain Optimizer Server + WebSocket listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

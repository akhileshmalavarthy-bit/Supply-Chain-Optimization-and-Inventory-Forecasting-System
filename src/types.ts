export type UserRole = 'SUPER_ADMIN' | 'OPS_MANAGER' | 'INVENTORY_ANALYST' | 'AUDITOR';

export interface Tenant {
  id: string;
  name: string;
  code: string;
  region: string;
  currencySymbol: string;
  currencyLocale: string;
  status: 'ACTIVE' | 'MAINTENANCE';
  createdAt: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  tenantIds: string[];
  oauthProvider: 'google-oauth2' | 'github-oauth2' | 'enterprise-oidc';
  mfaEnabled: boolean;
  lastActive: string;
}

export interface Supplier {
  id: number;
  tenantId: string;
  name: string;
  leadTimeReliability?: number;
}

export interface Product {
  id: number;
  tenantId: string;
  sku: string;
  name: string;
  cost: number;
  lead: number;
  opening: number;
  safety: number;
  rop: number;
  base: number;
  sup: number;
}

export type TransactionType = 'IN' | 'OUT' | 'ADJUST';

export interface InventoryTransaction {
  id: number;
  tenantId: string;
  pid: number;
  date: string;
  type: TransactionType;
  qty: number; // Signed quantity in ledger: IN is +, OUT is -, ADJUST is +/-
  note: string;
  actorName?: string;
}

export type POStatus = 'pending' | 'received' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  sup: number;
  pid: number;
  qty: number;
  od: string;
  ex: string;
  rc: string | null;
  st: POStatus;
}

export interface AuditLogEntry {
  id: number;
  tenantId: string;
  k: string; // Category tag e.g. 'Stock IN', 'Product added', 'OAuth2 Login', 'RBAC Policy'
  m: string; // Description message
  d: string; // Date YYYY-MM-DD
  timestamp: string; // ISO timestamp
  actorEmail: string;
  actorRole: UserRole;
  ip: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  n: number; // Sequence number
}

export interface TenantDataState {
  tenant: Tenant;
  today: string;
  dates: string[];
  suppliers: Supplier[];
  products: Product[];
  demand: Record<number, number[]>;
  transactions: InventoryTransaction[];
  purchaseOrders: PurchaseOrder[];
  auditLogs: AuditLogEntry[];
}

export interface PresenceClient {
  clientId: string;
  userName: string;
  userEmail: string;
  role: UserRole;
  tenantId: string;
  connectedAt: string;
}

export interface CalculatedProductAnalytics {
  p: Product;
  s: number; // Current stock derived from ledger
  a: number; // Average daily demand over window
  ld: number; // Demand during lead time
  rop: number; // Calculated reorder point
  inc: number; // Incoming pending PO stock within lead time
  av: number; // Available stock (s + inc)
  days: number; // Days of stock cover left
  risk: [string, 'r' | 'o' | 'g' | 'b'];
  f: string; // Filter category string ('reorder stockout', 'reorder', 'excess', 'ok')
  why: string;
  act: string;
}

export interface SupplierPerformanceMetrics {
  supplier: Supplier;
  total: number;
  done: number;
  ont: number | null;
  delay: number | null;
  dl: number[];
}

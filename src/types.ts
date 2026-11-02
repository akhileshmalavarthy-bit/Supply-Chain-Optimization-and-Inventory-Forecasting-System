export type UserRole = 'SUPER_ADMIN' | 'OPS_MANAGER' | 'INVENTORY_ANALYST' | 'AUDITOR';

export type StockStatusLabel = 'In Stock' | 'Low Stock' | 'Out of Stock';

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
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  status?: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE';
  isSample?: boolean;
  leadTimeReliability?: number;
}

export interface Product {
  id: number;
  productId?: string;
  tenantId: string;
  sku: string;
  name: string;
  productName?: string;
  category?: string;
  description?: string;
  unit?: string;
  cost: number;
  purchaseCost?: number;
  sellingPrice?: number;
  currentStock?: number;
  lowStockThreshold?: number;
  stockStatus?: StockStatusLabel;
  status?: 'ACTIVE' | 'DISCONTINUED';
  lead: number;
  opening: number;
  safety: number;
  rop: number;
  base: number;
  sup: number;
  isSample?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface InventoryRecord {
  productId: number;
  tenantId: string;
  sku: string;
  productName: string;
  quantityOnHand: number;
  reorderLevel: number;
  safetyStock: number;
  warehouseLocation: string;
  status: 'In Stock' | 'Healthy Stock' | 'Low Stock' | 'Out of Stock';
  isSample?: boolean;
  lastUpdated?: string;
}

export type TransactionType = 'IN' | 'OUT' | 'ADJUST';
export type StockMovementType = 'PURCHASE' | 'SALE' | 'ADJUST';

export interface InventoryTransaction {
  id: number;
  tenantId: string;
  pid: number;
  productId?: string;
  productName?: string;
  date: string;
  type: TransactionType;
  transactionType?: StockMovementType;
  qty: number; // Signed quantity in ledger: IN/PURCHASE is +, OUT/SALE is -, ADJUST is +/-
  quantity?: number; // Absolute quantity moved
  resultingStock?: number; // Resulting stock balance after transaction
  note: string;
  relatedOrderId?: string;
  actorName?: string;
  timestamp?: string;
  createdAt?: string;
  isSample?: boolean;
}

export type POStatus = 'pending' | 'received' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  sup: number;
  pid: number;
  productName?: string;
  qty: number;
  unitPrice?: number;
  total?: number;
  od: string;
  ex: string;
  rc: string | null;
  st: POStatus;
  isSample?: boolean;
}

export interface ForecastRecord {
  productId: number;
  tenantId: string;
  sku: string;
  productName: string;
  forecastPeriod: string;
  windowDays: number;
  historySeries: number[];
  predictedDailyDemand: number;
  projectedPeriodTotal: number;
  method: string;
  maeMean: number;
  maeNaive: number;
  isSample?: boolean;
  generatedAt?: string;
}

export interface NotificationRecord {
  id: string;
  tenantId: string;
  userId: string;
  message: string;
  type: 'LOW_STOCK' | 'OUT_OF_STOCK' | 'PO_UPDATE' | 'SYSTEM';
  relatedRecordId: string;
  read: boolean;
  createdAt?: string;
}

export interface ReportRecord {
  id: string;
  tenantId: string;
  reportType: 'CSV_RECOMMENDATIONS' | 'JSON_EXECUTIVE_SUMMARY';
  dateRange: string;
  summary: string;
  totalProducts: number;
  inventoryValue: number;
  belowRopCount: number;
  generatedBy: string;
  generatedAt?: string;
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
  inventory?: InventoryRecord[];
  demand: Record<number, number[]>;
  transactions: InventoryTransaction[];
  purchaseOrders: PurchaseOrder[];
  forecasts?: ForecastRecord[];
  notifications?: NotificationRecord[];
  reports?: ReportRecord[];
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

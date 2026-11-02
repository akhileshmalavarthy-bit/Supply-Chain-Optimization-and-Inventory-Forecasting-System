import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { auth, googleProvider, firebaseConfig } from './firebase';
import {
  ensureUserProfileInFirestore,
  ensureTenantSeededInFirestore,
  subscribeToTenantCollections,
  saveProductInFirestore,
  deleteProductFromFirestore,
  formatProductId,
  recordInventoryTransactionInFirestore,
  createPurchaseOrderInFirestore,
  updatePurchaseOrderStatusInFirestore,
  saveSupplierInFirestore,
  deleteSupplierFromFirestore,
  saveForecastInFirestore,
  markNotificationReadInFirestore,
  deleteNotificationFromFirestore,
  saveReportToFirestore,
  deleteReportFromFirestore,
  updateUserRoleInFirestore,
  persistAuditLogToFirestore,
  persistNewTenantToFirestore,
} from './services/firestoreSync';
import {
  Tenant,
  UserProfile,
  UserRole,
  TenantDataState,
  Product,
  InventoryRecord,
  Supplier,
  InventoryTransaction,
  PurchaseOrder,
  ForecastRecord,
  NotificationRecord,
  ReportRecord,
  PresenceClient,
  StockMovementType,
} from './types';
import {
  sum,
  formatDate,
  addDays,
  formatCurrency,
  getStock,
  getStockStatus,
  computeStockStatusLabel,
  calculateProductAnalytics,
  calculateSupplierMetrics,
} from './utils/analytics';
import {
  D3InventoryDonut,
  D3DemandChart,
  D3SupplierBarChart,
  D3StockVsRopChart,
  D3InventoryValueChart,
  D3ForecastChart,
} from './components/D3Charts';
import {
  Download,
  FileSpreadsheet,
  ShieldCheck,
  Building2,
  Database,
  LogIn,
  LogOut,
  Plus,
  Search,
  CheckCircle2,
  XCircle,
  Bell,
  RefreshCw,
  Trash2,
  Sparkles,
} from 'lucide-react';

type PageKey = 'dash' | 'prod' | 'inv' | 'ana' | 'rec' | 'sec';

const PAGES: [PageKey, string][] = [
  ['dash', 'Dashboard'],
  ['prod', 'Products'],
  ['inv', 'Inventory'],
  ['ana', 'Analytics'],
  ['rec', 'Recommendations'],
  ['sec', 'Security & Tenants'],
];

const DEFAULT_CATEGORIES = [
  'Computing & Displays',
  'Peripherals & Audio',
  'Storage Media',
  'Networking & Cabling',
  'General Electronics',
];

const ROLE_PERMISSIONS_MAP: Record<UserRole, string[]> = {
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

interface ToastMsg {
  id: number;
  message: string;
  isError?: boolean;
}

export default function App() {
  const [activePage, setActivePage] = useState<PageKey>('dash');
  const [barLoading, setBarLoading] = useState(false);

  // Firebase Auth & Firestore Persistence State
  const [fbUser, setFbUser] = useState<FirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [firestoreSynced, setFirestoreSynced] = useState<boolean>(false);
  const [firestoreLoading, setFirestoreLoading] = useState<boolean>(false);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);

  // RBAC & Multi-Tenant state
  const [token, setToken] = useState<string>('oauth2_ent_tok_akhilesh_superadmin_2026');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [permissions, setPermissions] = useState<string[]>(ROLE_PERMISSIONS_MAP.SUPER_ADMIN);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string>('tenant-in-01');
  const [tenantState, setTenantState] = useState<TenantDataState | null>(null);
  const [presence, setPresence] = useState<PresenceClient[]>([]);
  const [wsConnected, setWsConnected] = useState<boolean>(false);

  // Additional Firestore-backed collections
  const [inventoryRecords, setInventoryRecords] = useState<InventoryRecord[]>([]);
  const [forecastRecords, setForecastRecords] = useState<ForecastRecord[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [savedReports, setSavedReports] = useState<ReportRecord[]>([]);
  const [notifOpen, setNotifOpen] = useState<boolean>(false);

  // Toasts
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastSeq = useRef(1);
  const showToast = useCallback((message: string, isError = false) => {
    const id = toastSeq.current++;
    setToasts((prev) => [...prev, { id, message, isError }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  // Dashboard filters
  const [demProductFilter, setDemProductFilter] = useState<string>('all');
  const [demMode, setDemMode] = useState<'d' | 'm'>('d');

  // Products & Inventory page filters & pagination
  const [prodQuery, setProdQuery] = useState('');
  const [prodCategoryFilter, setProdCategoryFilter] = useState<string>('all');
  const [prodStatusFilter, setProdStatusFilter] = useState<'all' | 'ok' | 'low' | 'out'>('all');
  const [prodSort, setProdSort] = useState<'name' | 'qty' | 'val'>('name');
  const [prodPage, setProdPage] = useState(1);

  // Product Modals
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [editingProduct, setEditingProduct] = useState<{
    id: number;
    productId: string;
    sku: string;
    name: string;
    category: string;
    description: string;
    unit: string;
    cost: string;
    sellingPrice: string;
    warehouseLocation: string;
    lead: string;
    rop: string;
    stock: string;
    safe: string;
    sup: number;
    errors: string[];
  } | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<Product | null>(null);

  // Supplier Modal
  const [editingSupplier, setEditingSupplier] = useState<{
    id: number;
    name: string;
    contactPerson: string;
    email: string;
    phone: string;
    address: string;
    status: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE';
  } | null>(null);

  // Stock Purchase / Sale & Inventory Ledger form state
  const [txPid, setTxPid] = useState<number>(1);
  const [txType, setTxType] = useState<'IN' | 'OUT' | 'ADJUST'>('IN');
  const [txQty, setTxQty] = useState<string>('');
  const [txDate, setTxDate] = useState<string>('2026-10-27');
  const [txNote, setTxNote] = useState<string>('');
  const [txOrderId, setTxOrderId] = useState<string>('');
  const [isSubmittingTx, setIsSubmittingTx] = useState<boolean>(false);
  const [invProdFilter, setInvProdFilter] = useState<string>('all');
  const [invFromDate, setInvFromDate] = useState<string>('');
  const [invToDate, setInvToDate] = useState<string>('');
  const [invSearch, setInvSearch] = useState<string>('');
  const [invPage, setInvPage] = useState<number>(1);

  // Analytics state
  const [anaWindow, setAnaWindow] = useState<number>(30);
  const [anaExcessThreshold, setAnaExcessThreshold] = useState<number>(60);
  const [anaForecastPid, setAnaForecastPid] = useState<number>(1);

  // Recommendations state
  const [recFilter, setRecFilter] = useState<string>('all');
  const [csvModalContent, setCsvModalContent] = useState<string | null>(null);

  // Security & Multi-tenant state
  const [auditSearch, setAuditSearch] = useState<string>('');
  const [auditSeverityFilter, setAuditSeverityFilter] = useState<string>('all');
  const [newTenantName, setNewTenantName] = useState<string>('');
  const [newTenantCode, setNewTenantCode] = useState<string>('');
  const [newTenantRegion, setNewTenantRegion] = useState<string>('Asia-Southeast (Singapore)');
  const [newTenantCurrency, setNewTenantCurrency] = useState<string>('₹');

  const wsRef = useRef<WebSocket | null>(null);
  const seedTemplateRef = useRef<TenantDataState | null>(null);
  const firestoreSyncedRef = useRef<boolean>(false);
  firestoreSyncedRef.current = firestoreSynced;
  const stockFormRef = useRef<HTMLDivElement | null>(null);

  const syncExpressCache = useCallback(
    (partial: Record<string, unknown>) => {
      fetch('/api/firestore/sync-tenant', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-tenant-id': activeTenantId,
        },
        body: JSON.stringify(partial),
      }).catch(() => {});
    },
    [token, activeTenantId]
  );

  const fetchBootstrap = useCallback(
    async (targetTenantId?: string, customToken?: string) => {
      try {
        const activeTok = customToken || token;
        const tId = targetTenantId || activeTenantId;
        const res = await fetch(`/api/bootstrap?tenantId=${encodeURIComponent(tId)}`, {
          headers: {
            Authorization: `Bearer ${activeTok}`,
            'x-tenant-id': tId,
          },
        });
        if (!res.ok) throw new Error('Failed to load workspace metadata');
        const data = await res.json();
        setUser(data.user);
        setAllUsers(data.users || []);
        setPermissions(data.permissions || []);
        setTenants(data.tenants || []);
        setActiveTenantId(data.activeTenantId);
        seedTemplateRef.current = data.state;

        if (!firestoreSyncedRef.current) {
          setTenantState(data.state);
        } else {
          setTenantState((prev) =>
            prev
              ? {
                  ...prev,
                  tenant: data.state.tenant,
                  today: data.state.today,
                  dates: data.state.dates,
                }
              : data.state
          );
        }

        if (data.state?.today) {
          setTxDate(data.state.today);
        }
      } catch (err) {
        console.error(err);
        showToast('Error connecting to supply chain API server', true);
      }
    },
    [token, activeTenantId, showToast]
  );

  useEffect(() => {
    fetchBootstrap();
  }, []);

  // Track Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setFbUser(currentUser);
      setAuthReady(true);
      if (!currentUser) {
        setFirestoreSynced(false);
        setFirestoreLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Attach Firestore seeding and real-time onSnapshot listeners when authenticated
  useEffect(() => {
    if (!authReady || !fbUser || !seedTemplateRef.current) return;

    let unsubSnapshots: (() => void) | null = null;
    let cancelled = false;
    const currentSeed = seedTemplateRef.current;

    async function initFirestoreForTenant() {
      setFirestoreLoading(true);
      setFirestoreError(null);
      try {
        const defaultRole: UserRole =
          fbUser!.email === 'akhileshmalavarthy@gmail.com'
            ? 'SUPER_ADMIN'
            : user?.role || 'INVENTORY_ANALYST';

        const profileInfo = await ensureUserProfileInFirestore(
          fbUser!.uid,
          fbUser!.displayName || user?.name || 'Supply Chain User',
          fbUser!.email || user?.email || 'authenticated@supplychain.io',
          defaultRole,
          activeTenantId
        );

        if (!cancelled && profileInfo.role) {
          setUser((prev) =>
            prev
              ? {
                  ...prev,
                  name: fbUser!.displayName || prev.name,
                  email: fbUser!.email || prev.email,
                  role: profileInfo.role,
                }
              : prev
          );
          setPermissions(ROLE_PERMISSIONS_MAP[profileInfo.role] || []);
        }

        await ensureTenantSeededInFirestore(
          fbUser!.uid,
          fbUser!.email || user?.email || 'authenticated@supplychain.io',
          currentSeed
        );
        if (cancelled) return;

        unsubSnapshots = subscribeToTenantCollections(activeTenantId, {
          onProducts: (products) => {
            setTenantState((prev) => (prev ? { ...prev, products } : prev));
            syncExpressCache({ products });
          },
          onInventory: (inventory) => {
            setInventoryRecords(inventory);
            syncExpressCache({ inventory });
          },
          onSuppliers: (suppliers) => {
            setTenantState((prev) => (prev ? { ...prev, suppliers } : prev));
            syncExpressCache({ suppliers });
          },
          onTransactions: (transactions) => {
            setTenantState((prev) => (prev ? { ...prev, transactions } : prev));
            syncExpressCache({ transactions });
          },
          onPurchaseOrders: (purchaseOrders) => {
            setTenantState((prev) => (prev ? { ...prev, purchaseOrders } : prev));
            syncExpressCache({ purchaseOrders });
          },
          onForecasts: (forecasts) => {
            setForecastRecords(forecasts);
            setTenantState((prev) => {
              if (!prev) return prev;
              const updatedDemand = { ...prev.demand };
              for (const f of forecasts) {
                if (Array.isArray(f.historySeries) && f.historySeries.length > 0) {
                  updatedDemand[f.productId] = f.historySeries;
                }
              }
              return { ...prev, demand: updatedDemand, forecasts };
            });
            syncExpressCache({ forecasts });
          },
          onNotifications: (notifs) => {
            setNotifications(notifs);
            syncExpressCache({ notifications: notifs });
          },
          onReports: (reports) => {
            setSavedReports(reports);
            syncExpressCache({ reports });
          },
          onAuditLogs: (auditLogs) => {
            setTenantState((prev) => (prev ? { ...prev, auditLogs } : prev));
            syncExpressCache({ auditLogs });
          },
          onLoaded: () => {
            setFirestoreSynced(true);
            setFirestoreLoading(false);
          },
        });
      } catch (err) {
        console.error('Firestore initialization error:', err);
        const msg = err instanceof Error ? err.message : 'Firestore connection error';
        setFirestoreError(msg);
        setFirestoreLoading(false);
        showToast('Firestore sync error — check banner details', true);
      }
    }

    initFirestoreForTenant();

    return () => {
      cancelled = true;
      if (unsubSnapshots) unsubSnapshots();
    };
  }, [authReady, fbUser, activeTenantId]);

  // Real-time WebSocket connection & auto-reconnect
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setWsConnected(true);
        if (user) {
          ws.send(
            JSON.stringify({
              type: 'client:identify',
              userName: fbUser?.displayName || user.name,
              userEmail: fbUser?.email || user.email,
              role: user.role,
              tenantId: activeTenantId,
            })
          );
        }
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const msg = JSON.parse(event.data);
          if (
            msg.type === 'state:sync' &&
            msg.tenantId === activeTenantId &&
            !firestoreSyncedRef.current
          ) {
            setTenantState(msg.state);
          } else if (msg.type === 'tenant:created') {
            setTenants(msg.tenants);
          } else if (msg.type === 'presence:update') {
            setPresence(msg.clients || []);
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connectWs, 2500);
      };
    };

    connectWs();
    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [activeTenantId, user?.email, user?.role, fbUser?.email, fbUser?.displayName]);

  const handleFirebaseGoogleSignIn = async () => {
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      showToast(`Connected to Cloud Firestore as ${cred.user.email}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in cancelled';
      showToast(`Firebase Sign-In: ${msg}`, true);
    }
  };

  const handleFirebaseSignOut = async () => {
    try {
      await signOut(auth);
      setFirestoreSynced(false);
      showToast('Signed out of Firebase Auth');
    } catch {
      showToast('Failed to sign out', true);
    }
  };

  const handleReloadSampleData = async () => {
    if (!fbUser || !seedTemplateRef.current) {
      showToast('Sign in with Google first to seed sample data into Firestore', true);
      return;
    }
    try {
      setFirestoreLoading(true);
      await ensureTenantSeededInFirestore(
        fbUser.uid,
        fbUser.email || user?.email || 'authenticated@supplychain.io',
        seedTemplateRef.current,
        true
      );
      setFirestoreLoading(false);
      showToast('Sample dataset seeded into Firestore (marked as SAMPLE)');
    } catch {
      setFirestoreLoading(false);
      showToast('Failed to seed sample data', true);
    }
  };

  const navigateTo = (page: PageKey) => {
    setBarLoading(true);
    setActivePage(page);
    setTimeout(() => setBarLoading(false), 350);
  };

  const handleTenantChange = (newTenantId: string) => {
    setBarLoading(true);
    setFirestoreSynced(false);
    setActiveTenantId(newTenantId);
    fetchBootstrap(newTenantId).finally(() => {
      setTimeout(() => setBarLoading(false), 350);
    });
    if (wsRef.current?.readyState === WebSocket.OPEN && user) {
      wsRef.current.send(
        JSON.stringify({
          type: 'client:identify',
          userName: fbUser?.displayName || user.name,
          userEmail: fbUser?.email || user.email,
          role: user.role,
          tenantId: newTenantId,
        })
      );
    }
    showToast(`Switched tenant workspace to ${newTenantId}`);
  };

  const handleSwitchUserOrRole = async (targetUserId: string, roleOverride?: UserRole) => {
    try {
      const res = await fetch('/api/auth/switch-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-tenant-id': activeTenantId,
        },
        body: JSON.stringify({ userId: targetUserId, role: roleOverride }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to switch role', true);
        return;
      }
      setToken(data.token);
      setUser(data.user);
      setPermissions(data.permissions);
      if (fbUser && roleOverride) {
        await updateUserRoleInFirestore(
          fbUser.uid,
          fbUser.displayName || data.user.name,
          fbUser.email || data.user.email,
          roleOverride,
          activeTenantId
        );
      }
      if (fbUser && data.auditLog) {
        await persistAuditLogToFirestore(activeTenantId, data.auditLog);
      }
      showToast(`Active session: ${data.user.name} (${data.user.role})`);
    } catch {
      showToast('Error switching RBAC identity', true);
    }
  };

  // Derived data from tenantState
  const currencySymbol = tenantState?.tenant.currencySymbol || '₹';
  const currencyLocale = tenantState?.tenant.currencyLocale || 'en-IN';
  const products = tenantState?.products || [];
  const suppliers = tenantState?.suppliers || [];
  const transactions = tenantState?.transactions || [];
  const purchaseOrders = tenantState?.purchaseOrders || [];
  const demandMap = tenantState?.demand || {};
  const dates = tenantState?.dates || [];
  const todayStr = tenantState?.today || '2026-10-27';
  const auditLogs = tenantState?.auditLogs || [];
  const nextAuditId = useMemo(
    () => auditLogs.reduce((max, x) => Math.max(max, x.n), 0) + 1,
    [auditLogs]
  );

  // Keep txPid valid when products list changes
  useEffect(() => {
    if (products.length > 0 && !products.some((p) => p.id === Number(txPid))) {
      setTxPid(products[0].id);
    }
  }, [products, txPid]);

  const fmtCurr = useCallback(
    (n: number) => formatCurrency(n, currencySymbol, currencyLocale),
    [currencySymbol, currencyLocale]
  );

  const getWarehouseForProduct = useCallback(
    (pid: number) => {
      const inv = inventoryRecords.find((r) => r.productId === pid);
      if (inv?.warehouseLocation) return inv.warehouseLocation;
      return `WH-${activeTenantId.includes('eu') ? 'FRA' : activeTenantId.includes('us') ? 'PDX' : 'BLR'}-A${((pid - 1) % 4) + 1}`;
    },
    [inventoryRecords, activeTenantId]
  );

  // Dashboard & Product/Inventory KPI calculations
  const dashAnalytics = useMemo(
    () =>
      products.map((p) =>
        calculateProductAnalytics(p, transactions, purchaseOrders, demandMap, todayStr, 30, 60)
      ),
    [products, transactions, purchaseOrders, demandMap, todayStr]
  );

  const totalInventoryUnits = useMemo(
    () => sum(products.map((p) => getStock(p, transactions))),
    [products, transactions]
  );

  const totalInventoryValue = useMemo(
    () => sum(products.map((p) => getStock(p, transactions) * (p.purchaseCost ?? p.cost))),
    [products, transactions]
  );

  const totalPotentialSellingValue = useMemo(
    () =>
      sum(
        products.map(
          (p) =>
            getStock(p, transactions) *
            (p.sellingPrice ?? Math.round((p.purchaseCost ?? p.cost) * 1.25))
        )
      ),
    [products, transactions]
  );

  const lowStockCount = useMemo(
    () => products.filter((p) => getStockStatus(p, transactions)[2] === 'low').length,
    [products, transactions]
  );

  const outOfStockCount = useMemo(
    () => products.filter((p) => getStockStatus(p, transactions)[2] === 'out').length,
    [products, transactions]
  );

  const stockoutCount = useMemo(
    () => dashAnalytics.filter((c) => c.f.includes('stockout')).length,
    [dashAnalytics]
  );

  const excessCount = useMemo(
    () => dashAnalytics.filter((c) => c.f === 'excess').length,
    [dashAnalytics]
  );

  const donutCounts = useMemo<[number, number, number, number]>(() => {
    const cnt: [number, number, number, number] = [0, 0, 0, 0];
    dashAnalytics.forEach((c) => {
      const st = getStockStatus(c.p, transactions)[2];
      const idx = st === 'out' ? 2 : st === 'low' ? 1 : c.f === 'excess' ? 3 : 0;
      cnt[idx]++;
    });
    return cnt;
  }, [dashAnalytics, transactions]);

  const demandChartData = useMemo(() => {
    if (dates.length === 0 || products.length === 0) {
      return { labels: [], values: [] };
    }
    const rawSeries =
      demProductFilter === 'all'
        ? dates.map((_d, i) => sum(products.map((p) => demandMap[p.id]?.[i] || 0)))
        : (demandMap[Number(demProductFilter)] || []).slice();

    if (demMode === 'm') {
      const grouped: Record<string, number> = {};
      dates.forEach((d, i) => {
        const key = d.slice(0, 7);
        grouped[key] = (grouped[key] || 0) + (rawSeries[i] || 0);
      });
      const monthLabels = Object.keys(grouped);
      return {
        labels: monthLabels,
        values: monthLabels.map((k) => grouped[k]),
      };
    }

    return {
      labels: dates,
      values: rawSeries,
    };
  }, [dates, products, demandMap, demProductFilter, demMode]);

  const supplierMetrics = useMemo(
    () => suppliers.map((s) => calculateSupplierMetrics(s, purchaseOrders)),
    [suppliers, purchaseOrders]
  );

  const supplierSummary = useMemo(() => {
    const tot = sum(supplierMetrics.map((m) => m.total));
    const rcv = sum(supplierMetrics.map((m) => m.done));
    const ont = sum(supplierMetrics.map((m) => m.dl.filter((d) => d <= 0).length));
    const dls = ([] as number[]).concat(...supplierMetrics.map((m) => m.dl));
    return {
      totalPos: tot,
      onTimeStr: rcv ? `${Math.round((100 * ont) / rcv)}%` : 'n/a',
      avgDelayStr: rcv ? `${(sum(dls) / dls.length).toFixed(1)} d` : 'n/a',
    };
  }, [supplierMetrics]);

  // Unique categories across products + default categories
  const availableCategories = useMemo(() => {
    const set = new Set<string>(DEFAULT_CATEGORIES);
    products.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set);
  }, [products]);

  // Filtered & sorted products
  const filteredProducts = useMemo(() => {
    const q = prodQuery.toLowerCase();
    const rows = products.filter((p) => {
      const pName = (p.productName || p.name).toLowerCase();
      const pCat = p.category || 'General Electronics';
      const matchesQ =
        !q ||
        pName.includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        String(p.productId || p.id).toLowerCase().includes(q) ||
        pCat.toLowerCase().includes(q);
      const matchesCat = prodCategoryFilter === 'all' || pCat === prodCategoryFilter;
      const stCode = getStockStatus(p, transactions)[2];
      const matchesF = prodStatusFilter === 'all' || stCode === prodStatusFilter;
      return matchesQ && matchesCat && matchesF;
    });
    rows.sort((a, b) => {
      if (prodSort === 'name')
        return (a.productName || a.name).localeCompare(b.productName || b.name);
      if (prodSort === 'qty') return getStock(b, transactions) - getStock(a, transactions);
      return (
        getStock(b, transactions) * (b.purchaseCost ?? b.cost) -
        getStock(a, transactions) * (a.purchaseCost ?? a.cost)
      );
    });
    return rows;
  }, [products, transactions, prodQuery, prodCategoryFilter, prodStatusFilter, prodSort]);

  const prodTotalPages = Math.max(1, Math.ceil(filteredProducts.length / 6));
  const safeProdPage = Math.min(prodTotalPages, Math.max(1, prodPage));

  // Product CRUD handlers (Firestore-first when authenticated)
  const openProductModal = (prod?: Product) => {
    if (prod) {
      const pCost = prod.purchaseCost ?? prod.cost;
      setEditingProduct({
        id: prod.id,
        productId: formatProductId(prod.id, prod.productId),
        sku: prod.sku,
        name: prod.productName || prod.name,
        category: prod.category || 'Computing & Displays',
        description: prod.description || `${prod.name} (${prod.sku})`,
        unit: prod.unit || 'units',
        cost: String(pCost),
        sellingPrice: String(prod.sellingPrice ?? Math.round(pCost * 1.25)),
        warehouseLocation: getWarehouseForProduct(prod.id),
        lead: String(prod.lead),
        rop: String(prod.lowStockThreshold ?? prod.rop),
        stock: String(getStock(prod, transactions)),
        safe: String(prod.safety),
        sup: prod.sup,
        errors: [],
      });
    } else {
      const nextId = products.reduce((max, x) => Math.max(max, x.id), 0) + 1;
      setEditingProduct({
        id: 0,
        productId: formatProductId(nextId),
        sku: `SKU-${String(nextId).padStart(3, '0')}`,
        name: '',
        category: 'Computing & Displays',
        description: '',
        unit: 'units',
        cost: '',
        sellingPrice: '',
        warehouseLocation: 'WH-BLR-A1',
        lead: '5',
        rop: '25',
        stock: '50',
        safe: '15',
        sup: suppliers[0]?.id || 1,
        errors: [],
      });
    }
  };

  const handleSaveProduct = async () => {
    if (!editingProduct) return;
    if (!permissions.includes('products:write')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot modify products`, true);
      return;
    }

    const isEdit = editingProduct.id > 0;
    const nextId = isEdit
      ? editingProduct.id
      : products.reduce((max, x) => Math.max(max, x.id), 0) + 1;
    const cleanProductId = editingProduct.productId.trim()
      ? formatProductId(nextId, editingProduct.productId.trim())
      : formatProductId(nextId);
    const cleanSku = editingProduct.sku.trim();
    const cleanName = editingProduct.name.trim();
    const cleanCategory = editingProduct.category.trim();
    const errors: string[] = [];

    if (!/^[A-Za-z0-9_-]{3,40}$/.test(cleanProductId)) {
      errors.push('Product ID (productId) must be 3-40 letters, digits, hyphens, or underscores (e.g. PROD001).');
    } else if (
      products.some(
        (p) =>
          p.id !== editingProduct.id &&
          formatProductId(p.id, p.productId).toLowerCase() === cleanProductId.toLowerCase()
      )
    ) {
      errors.push(`Duplicate Product ID: "${cleanProductId}" already exists.`);
    }
    if (!/^[A-Za-z0-9-]{3,20}$/.test(cleanSku)) {
      errors.push('SKU must be 3-20 letters, digits or hyphens.');
    } else if (
      products.some(
        (p) => p.id !== editingProduct.id && p.sku.toLowerCase() === cleanSku.toLowerCase()
      )
    ) {
      errors.push('Duplicate SKU: this SKU already exists.');
    }
    if (!cleanName || cleanName.length > 60) {
      errors.push('Product Name is required (1-60 characters).');
    }
    if (!cleanCategory || cleanCategory.length > 40) {
      errors.push('Category is required (1-40 characters).');
    }
    if (editingProduct.cost.trim() === '' || isNaN(+editingProduct.cost) || +editingProduct.cost < 0) {
      errors.push('Purchase Cost must be a non-negative number (>= 0).');
    }
    if (
      editingProduct.sellingPrice.trim() === '' ||
      isNaN(+editingProduct.sellingPrice) ||
      +editingProduct.sellingPrice < 0
    ) {
      errors.push('Selling Price must be a non-negative number (>= 0).');
    }
    const isWhole = (v: string, mx: number) =>
      v.trim() !== '' && Number.isInteger(+v) && +v >= 0 && +v <= mx;
    if (!isWhole(editingProduct.lead, 365))
      errors.push('Lead time must be a whole number of days (0-365).');
    if (!isWhole(editingProduct.rop, 1e6))
      errors.push('Low-stock threshold (Reorder Point) must be a non-negative integer (>= 0).');
    if (!isWhole(editingProduct.stock, 1e7))
      errors.push('Current stock must be a non-negative integer (>= 0).');
    if (!isWhole(editingProduct.safe, 1e6))
      errors.push('Safety stock must be a non-negative integer (>= 0).');

    if (errors.length > 0) {
      setEditingProduct((prev) => (prev ? { ...prev, errors } : null));
      showToast(errors[0] || 'Please fix the highlighted validation errors', true);
      return;
    }

    const targetStock = +editingProduct.stock;
    const lowStockThreshold = +editingProduct.rop;
    const purchaseCostVal = +editingProduct.cost;
    const sellingPriceVal = +editingProduct.sellingPrice;
    const autoStockStatus = computeStockStatusLabel(targetStock, lowStockThreshold);

    const existingProd = isEdit ? products.find((p) => p.id === editingProduct.id) : null;
    const txDeltaSum = existingProd
      ? sum(transactions.filter((t) => t.pid === existingProd.id).map((t) => t.qty))
      : 0;
    const newOpening = existingProd ? Math.max(0, targetStock - txDeltaSum) : targetStock;

    const productRecord: Product = {
      id: nextId,
      productId: cleanProductId,
      tenantId: activeTenantId,
      sku: cleanSku,
      name: cleanName,
      productName: cleanName,
      category: cleanCategory,
      description: editingProduct.description.trim() || `${cleanName} (${cleanSku})`,
      unit: editingProduct.unit.trim() || 'units',
      cost: purchaseCostVal,
      purchaseCost: purchaseCostVal,
      sellingPrice: sellingPriceVal,
      currentStock: targetStock,
      lowStockThreshold,
      stockStatus: autoStockStatus,
      status: 'ACTIVE',
      lead: +editingProduct.lead,
      rop: lowStockThreshold,
      safety: +editingProduct.safe,
      sup: +editingProduct.sup || 1,
      opening: newOpening,
      base: existingProd?.base ?? 6,
      isSample: false,
    };

    try {
      if (fbUser) {
        await saveProductInFirestore({
          uid: fbUser.uid,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'SUPER_ADMIN',
          tenantId: activeTenantId,
          todayStr,
          product: productRecord,
          currentLedgerStock: targetStock,
          warehouseLocation: editingProduct.warehouseLocation.trim() || 'WH-BLR-A1',
          isNew: !isEdit,
          nextAuditId,
        });
        setEditingProduct(null);
        showToast(
          isEdit
            ? `Updated /products/${cleanProductId} (${productRecord.name}) in Firestore (${autoStockStatus})`
            : `Saved /products/${cleanProductId} (${productRecord.name}) to Firestore (${autoStockStatus})`
        );
      } else {
        const url = isEdit ? `/api/products/${editingProduct.id}` : '/api/products';
        const method = isEdit ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-tenant-id': activeTenantId,
          },
          body: JSON.stringify(editingProduct),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to save product', true);
          return;
        }
        // Merge rich fields in session preview
        setTenantState((prev) => {
          const nextState: TenantDataState = data.state;
          return {
            ...nextState,
            products: nextState.products.map((p) =>
              p.id === nextId ? { ...p, ...productRecord } : p
            ),
          };
        });
        setEditingProduct(null);
        showToast('Saved in session preview (Sign in with Google to persist to Firestore)');
      }
    } catch (err) {
      console.error(err);
      const errMsg = err instanceof Error ? err.message : 'Error saving product to Firestore';
      setEditingProduct((prev) => (prev ? { ...prev, errors: [errMsg] } : null));
      showToast(errMsg, true);
    }
  };

  const handleDeleteProduct = async (id: number) => {
    if (!permissions.includes('products:delete')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot delete products`, true);
      setDeletingProduct(null);
      return;
    }
    const prod = products.find((p) => p.id === id);
    if (!prod) return;

    try {
      if (fbUser) {
        const relatedTxIds = transactions.filter((t) => t.pid === id).map((t) => t.id);
        await deleteProductFromFirestore({
          tenantId: activeTenantId,
          product: prod,
          relatedTxIds,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'SUPER_ADMIN',
          todayStr,
          nextAuditId,
        });
        setDeletingProduct(null);
        showToast(
          `Deleted /products/${formatProductId(prod.id, prod.productId)} (${prod.name}) from Firestore`
        );
      } else {
        const res = await fetch(`/api/products/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-tenant-id': activeTenantId,
          },
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to delete product', true);
          setDeletingProduct(null);
          return;
        }
        setTenantState(data.state);
        setDeletingProduct(null);
        showToast('Deleted in session preview');
      }
    } catch {
      showToast('Error deleting product from Firestore', true);
    }
  };

  // Supplier CRUD handlers
  const handleSaveSupplier = async () => {
    if (!editingSupplier) return;
    if (!permissions.includes('products:write')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot modify suppliers`, true);
      return;
    }
    if (!editingSupplier.name.trim()) {
      showToast('Supplier name is required', true);
      return;
    }
    const isNew = editingSupplier.id === 0;
    const nextSupId = isNew
      ? suppliers.reduce((max, s) => Math.max(max, s.id), 0) + 1
      : editingSupplier.id;

    const supRecord: Supplier = {
      id: nextSupId,
      tenantId: activeTenantId,
      name: editingSupplier.name.trim(),
      contactPerson: editingSupplier.contactPerson.trim() || 'Operations Desk',
      email: editingSupplier.email.trim() || 'orders@supplier.io',
      phone: editingSupplier.phone.trim() || '+91-80-4000-0000',
      address: editingSupplier.address.trim() || 'Industrial Logistics Park',
      status: editingSupplier.status,
      isSample: false,
    };

    try {
      if (fbUser) {
        await saveSupplierInFirestore({
          tenantId: activeTenantId,
          supplier: supRecord,
          isNew,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'SUPER_ADMIN',
          todayStr,
          nextAuditId,
        });
        setEditingSupplier(null);
        showToast(`Saved supplier ${supRecord.name} to Firestore`);
      } else {
        setTenantState((prev) => {
          if (!prev) return prev;
          const updated = isNew
            ? [...prev.suppliers, supRecord]
            : prev.suppliers.map((s) => (s.id === supRecord.id ? supRecord : s));
          return { ...prev, suppliers: updated };
        });
        setEditingSupplier(null);
        showToast('Saved supplier in session preview');
      }
    } catch {
      showToast('Failed to save supplier to Firestore', true);
    }
  };

  const handleDeleteSupplier = async (sup: Supplier) => {
    if (!permissions.includes('products:delete')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot delete suppliers`, true);
      return;
    }
    try {
      if (fbUser) {
        await deleteSupplierFromFirestore({
          tenantId: activeTenantId,
          supplier: sup,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'SUPER_ADMIN',
          todayStr,
          nextAuditId,
        });
        showToast(`Deleted supplier ${sup.name} from Firestore`);
      } else {
        setTenantState((prev) =>
          prev ? { ...prev, suppliers: prev.suppliers.filter((s) => s.id !== sup.id) } : prev
        );
        showToast('Removed supplier in session preview');
      }
    } catch {
      showToast('Failed to delete supplier', true);
    }
  };

  // Stock Purchase / Sale preview & warning
  const selectedTxProduct = useMemo(
    () => products.find((x) => x.id === Number(txPid)) || products[0],
    [products, txPid]
  );

  const txPreviewInfo = useMemo(() => {
    if (!selectedTxProduct) return null;
    const avail = getStock(selectedTxProduct, transactions);
    const threshold = selectedTxProduct.lowStockThreshold ?? selectedTxProduct.rop;
    const rawQty = txQty.trim() === '' ? 0 : Number(txQty);
    const delta = txType === 'IN' ? rawQty : txType === 'OUT' ? -rawQty : rawQty;
    const projectedStock = avail + delta;
    const projectedStatus = computeStockStatusLabel(Math.max(0, projectedStock), threshold);
    const isNegative = projectedStock < 0;
    return {
      avail,
      threshold,
      delta,
      projectedStock,
      projectedStatus,
      isNegative,
    };
  }, [selectedTxProduct, transactions, txQty, txType]);

  const txWarning = useMemo(() => {
    if (!txPreviewInfo || txQty.trim() === '') return '';
    if (txPreviewInfo.isNegative) {
      return `Warning: Sale/Out of ${Math.abs(txPreviewInfo.delta)} units exceeds available stock (${txPreviewInfo.avail} units). Negative stock is strictly prevented.`;
    }
    return '';
  }, [txPreviewInfo, txQty]);

  const handleQuickSelectStockAction = (product: Product, actionType: 'IN' | 'OUT') => {
    setTxPid(product.id);
    setTxType(actionType);
    setTxQty('5');
    setTxNote(
      actionType === 'IN'
        ? `Stock Purchase — ${product.productName || product.name}`
        : `Stock Sale — ${product.productName || product.name}`
    );
    stockFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleSaveTransaction = async () => {
    if (isSubmittingTx) return;
    if (!permissions.includes('inventory:write')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot record stock movements`, true);
      return;
    }
    const product = products.find((p) => p.id === Number(txPid));
    const q = Number(txQty);
    if (
      !product ||
      txQty.trim() === '' ||
      !Number.isInteger(q) ||
      q === 0 ||
      (txType !== 'ADJUST' && q <= 0)
    ) {
      showToast('Enter a valid positive whole-number quantity', true);
      return;
    }

    const currentStock = getStock(product, transactions);
    const delta = txType === 'IN' ? q : txType === 'OUT' ? -q : q;
    const resultingStock = currentStock + delta;
    if (resultingStock < 0) {
      showToast(
        `Rejected: Stock cannot become negative (available: ${currentStock} units, requested sale: ${Math.abs(delta)} units)`,
        true
      );
      return;
    }

    const movementType: StockMovementType =
      txType === 'IN' ? 'PURCHASE' : txType === 'OUT' ? 'SALE' : 'ADJUST';
    const nextTxId = transactions.reduce((max, x) => Math.max(max, x.id), 0) + 1;
    const dt = txDate || todayStr;
    const defaultNote =
      txType === 'IN'
        ? `Stock Purchase (+${q} units)`
        : txType === 'OUT'
        ? `Customer Sale (-${q} units)`
        : `Stock Adjustment (${delta > 0 ? '+' : ''}${delta} units)`;

    const txObj: InventoryTransaction = {
      id: nextTxId,
      tenantId: activeTenantId,
      pid: product.id,
      productId: String(product.id),
      productName: product.productName || product.name,
      date: dt,
      type: txType,
      transactionType: movementType,
      qty: delta,
      quantity: Math.abs(delta),
      resultingStock,
      note: (txNote.trim() || defaultNote).slice(0, 120),
      relatedOrderId: txOrderId.trim().slice(0, 32) || '-',
      actorName: fbUser?.email || user?.email || 'authenticated@supplychain.io',
      timestamp: new Date().toISOString(),
      isSample: false,
    };

    setIsSubmittingTx(true);
    try {
      if (fbUser) {
        const newStock = await recordInventoryTransactionInFirestore({
          uid: fbUser.uid,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'INVENTORY_ANALYST',
          tenantId: activeTenantId,
          product,
          currentLedgerStock: currentStock,
          tx: txObj,
          nextAuditId,
        });
        setTxQty('');
        setTxNote('');
        setTxOrderId('');
        const newStatus = computeStockStatusLabel(
          newStock,
          product.lowStockThreshold ?? product.rop
        );
        showToast(
          `${movementType} recorded in Firestore! Resulting stock: ${newStock} units (${newStatus})`
        );
      } else {
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-tenant-id': activeTenantId,
          },
          body: JSON.stringify({
            pid: txPid,
            type: txType,
            qty: txQty,
            date: dt,
            note: txObj.note,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to record transaction', true);
          return;
        }
        setTenantState(data.state);
        setTxQty('');
        setTxNote('');
        setTxOrderId('');
        showToast(`${movementType} recorded in preview. Resulting stock: ${data.newStock}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save transaction';
      showToast(msg, true);
    } finally {
      setIsSubmittingTx(false);
    }
  };

  const getProductName = useCallback(
    (pid: number) => {
      const p = products.find((x) => x.id === pid);
      return p ? p.productName || p.name : '(deleted)';
    },
    [products]
  );

  // Compute running resultingStock for any legacy/preview transactions that don't have it explicitly stored
  const computedResultingStockMap = useMemo(() => {
    const map: Record<number, number> = {};
    const runningByProd: Record<number, number> = {};
    products.forEach((p) => {
      runningByProd[p.id] = p.opening;
    });
    const chronological = [...transactions].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id
    );
    chronological.forEach((t) => {
      const prev = runningByProd[t.pid] ?? 0;
      const next = Math.max(0, prev + t.qty);
      runningByProd[t.pid] = next;
      map[t.id] = t.resultingStock !== undefined ? t.resultingStock : next;
    });
    return map;
  }, [products, transactions]);

  const filteredTransactions = useMemo(() => {
    const q = invSearch.toLowerCase();
    return transactions
      .filter((t) => {
        const matchProd = invProdFilter === 'all' || t.pid === Number(invProdFilter);
        const matchFrom = !invFromDate || t.date >= invFromDate;
        const matchTo = !invToDate || t.date <= invToDate;
        const pName = (t.productName || getProductName(t.pid)).toLowerCase();
        const movLabel = (
          t.transactionType ||
          (t.type === 'IN' ? 'PURCHASE' : t.type === 'OUT' ? 'SALE' : 'ADJUST')
        ).toLowerCase();
        const matchQ =
          !q ||
          t.note.toLowerCase().includes(q) ||
          pName.includes(q) ||
          movLabel.includes(q) ||
          (t.relatedOrderId || '').toLowerCase().includes(q);
        return matchProd && matchFrom && matchTo && matchQ;
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  }, [transactions, invProdFilter, invFromDate, invToDate, invSearch, getProductName]);

  const invTotalPages = Math.max(1, Math.ceil(filteredTransactions.length / 8));
  const safeInvPage = Math.min(invTotalPages, Math.max(1, invPage));

  // Analytics calculations
  const anaCalculations = useMemo(() => {
    const thr = Math.max(1, Number(anaExcessThreshold) || 60);
    return products.map((p) =>
      calculateProductAnalytics(
        p,
        transactions,
        purchaseOrders,
        demandMap,
        todayStr,
        anaWindow,
        thr
      )
    );
  }, [products, transactions, purchaseOrders, demandMap, todayStr, anaWindow, anaExcessThreshold]);

  const forecastEval = useMemo(() => {
    const p = products.find((x) => x.id === Number(anaForecastPid)) || products[0];
    if (!p || !demandMap[p.id] || dates.length === 0) {
      return null;
    }
    const a = demandMap[p.id];
    const H = 14;
    const tr = a.slice(0, -H);
    const te = a.slice(-H);
    const m = sum(tr) / Math.max(1, tr.length);
    const last = tr[tr.length - 1] || 0;
    const mae = (f: number) => sum(te.map((x) => Math.abs(x - f))) / Math.max(1, te.length);
    const base = sum(a.slice(-anaWindow)) / Math.max(1, anaWindow);
    const histDates = dates.slice(-60);
    const histValues = a.slice(-60);
    const forecastDates: string[] = [];
    for (let j = 1; j <= H; j++) {
      forecastDates.push(formatDate(addDays(todayStr, j)));
    }
    const savedDoc = forecastRecords.find((f) => f.productId === p.id);
    return {
      product: p,
      H,
      trLen: tr.length,
      base,
      maeMean: mae(m),
      maeNaive: mae(last),
      histDates,
      histValues,
      forecastDates,
      fullSeries: a.slice(-90),
      savedDoc,
    };
  }, [products, demandMap, dates, todayStr, anaForecastPid, anaWindow, forecastRecords]);

  const handleSaveForecast = async () => {
    if (!forecastEval) return;
    if (!fbUser) {
      showToast('Sign in with Google first to save forecasts to Firestore', true);
      return;
    }
    try {
      await saveForecastInFirestore({
        tenantId: activeTenantId,
        forecast: {
          productId: forecastEval.product.id,
          tenantId: activeTenantId,
          sku: forecastEval.product.sku,
          productName: forecastEval.product.name,
          forecastPeriod: `Next ${forecastEval.H} Days`,
          windowDays: anaWindow,
          historySeries: forecastEval.fullSeries,
          predictedDailyDemand: forecastEval.base,
          projectedPeriodTotal: Math.round(forecastEval.base * forecastEval.H),
          method: `${anaWindow}-Day Moving Average Baseline`,
          maeMean: forecastEval.maeMean,
          maeNaive: forecastEval.maeNaive,
          isSample: false,
        },
        userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
        userRole: user?.role || 'INVENTORY_ANALYST',
        todayStr,
        nextAuditId,
      });
      showToast(`Saved ${forecastEval.product.name} forecast to Firestore`);
    } catch {
      showToast('Failed to save forecast to Firestore', true);
    }
  };

  // Recommendations rows
  const recommendationRows = useMemo(() => {
    return dashAnalytics.filter(
      (c) => recFilter === 'all' || c.f.split(' ').includes(recFilter)
    );
  }, [dashAnalytics, recFilter]);

  const buildCsvString = () => {
    const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      'Product,SKU,Current Stock,Reorder Point,Incoming PO Units,Risk Level,Reason,Suggested Action',
      ...recommendationRows.map((c) =>
        [
          q(c.p.name),
          q(c.p.sku),
          c.s,
          c.rop,
          c.inc,
          q(c.risk[0]),
          q(c.why),
          q(c.act),
        ].join(',')
      ),
    ];
    return lines.join('\n');
  };

  const handleDownloadCsvFile = async () => {
    const csvText = buildCsvString();
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `supply_chain_recommendations_${activeTenantId}_${todayStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    if (fbUser) {
      await saveReportToFirestore({
        tenantId: activeTenantId,
        reportType: 'CSV_RECOMMENDATIONS',
        dateRange: `${dates[0] || todayStr} to ${todayStr}`,
        summary: `Exported ${recommendationRows.length} SKU recommendations (${lowStockCount + outOfStockCount} below ROP)`,
        totalProducts: products.length,
        inventoryValue: totalInventoryValue,
        belowRopCount: lowStockCount + outOfStockCount,
        generatedBy: fbUser.email || user?.email || 'authenticated@supplychain.io',
      }).catch(() => {});
    }
    showToast(
      fbUser
        ? 'Downloaded CSV & saved report record to Firestore'
        : 'Downloaded stakeholder CSV report'
    );
  };

  const handleDownloadJsonReport = async () => {
    const reportPayload = {
      generatedAt: new Date().toISOString(),
      tenant: tenantState?.tenant,
      generatedBy: fbUser?.email || user?.email,
      firestoreProjectId: firebaseConfig.projectId,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
      kpis: {
        totalProducts: products.length,
        totalInventoryUnits,
        lowStockProducts: lowStockCount,
        outOfStockProducts: outOfStockCount,
        inventoryPurchaseValue: totalInventoryValue,
        potentialSellingValue: totalPotentialSellingValue,
      },
      recommendations: recommendationRows.map((r) => ({
        sku: r.p.sku,
        name: r.p.name,
        stock: r.s,
        rop: r.rop,
        risk: r.risk[0],
        reason: r.why,
        action: r.act,
      })),
    };
    const blob = new Blob([JSON.stringify(reportPayload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `executive_forecast_report_${activeTenantId}_${todayStr}.json`;
    a.click();
    URL.revokeObjectURL(url);

    if (fbUser) {
      await saveReportToFirestore({
        tenantId: activeTenantId,
        reportType: 'JSON_EXECUTIVE_SUMMARY',
        dateRange: `${dates[0] || todayStr} to ${todayStr}`,
        summary: `Executive JSON audit snapshot · Purchase Value ${fmtCurr(totalInventoryValue)} · Selling Value ${fmtCurr(totalPotentialSellingValue)}`,
        totalProducts: products.length,
        inventoryValue: totalInventoryValue,
        belowRopCount: lowStockCount + outOfStockCount,
        generatedBy: fbUser.email || user?.email || 'authenticated@supplychain.io',
      }).catch(() => {});
    }
    showToast(
      fbUser
        ? 'Exported JSON & saved report record to Firestore'
        : 'Generated stakeholder JSON audit report'
    );
  };

  const handleCreatePurchaseOrder = async (pid: number, suggestedQty: number) => {
    if (!permissions.includes('po:write')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot create purchase orders`, true);
      return;
    }
    const product = products.find((p) => p.id === pid);
    if (!product) return;

    const orderQty = Math.max(1, Math.round(Number(suggestedQty) || 10));
    const maxPoNum = purchaseOrders.reduce((max, po) => {
      const m = /^PO-(\d+)$/.exec(po.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 1000);
    const poObj: PurchaseOrder = {
      id: `PO-${maxPoNum + 1}`,
      tenantId: activeTenantId,
      sup: product.sup,
      pid: product.id,
      productName: product.name,
      qty: orderQty,
      unitPrice: product.cost,
      total: product.cost * orderQty,
      od: todayStr,
      ex: formatDate(addDays(todayStr, product.lead)),
      rc: null,
      st: 'pending',
      isSample: false,
    };

    try {
      if (fbUser) {
        await createPurchaseOrderInFirestore({
          uid: fbUser.uid,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'OPS_MANAGER',
          tenantId: activeTenantId,
          todayStr,
          po: poObj,
          product,
          nextAuditId,
        });
        showToast(`Created ${poObj.id} (${orderQty} units) in Cloud Firestore`);
      } else {
        const res = await fetch('/api/purchase-orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-tenant-id': activeTenantId,
          },
          body: JSON.stringify({ pid, qty: orderQty }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Could not create PO', true);
          return;
        }
        setTenantState(data.state);
        showToast(`Created ${data.purchaseOrder.id} in session preview`);
      }
    } catch {
      showToast('Failed to create purchase order', true);
    }
  };

  const handleUpdatePoStatus = async (poId: string, status: 'received' | 'cancelled') => {
    if (!permissions.includes('po:write')) {
      showToast(`RBAC Denied: Role ${user?.role} cannot update purchase orders`, true);
      return;
    }
    const po = purchaseOrders.find((x) => x.id === poId);
    if (!po) return;
    const product = products.find((p) => p.id === po.pid);
    const currentStock = product ? getStock(product, transactions) : 0;
    const nextTxId = transactions.reduce((max, x) => Math.max(max, x.id), 0) + 1;

    try {
      if (fbUser) {
        await updatePurchaseOrderStatusInFirestore({
          uid: fbUser.uid,
          userEmail: fbUser.email || user?.email || 'authenticated@supplychain.io',
          userRole: user?.role || 'OPS_MANAGER',
          tenantId: activeTenantId,
          todayStr,
          po,
          newStatus: status,
          product,
          currentLedgerStock: currentStock,
          nextTxId,
          nextAuditId,
        });
        showToast(
          status === 'received'
            ? `${poId} received (+${po.qty} units credited atomically in Firestore)`
            : `${poId} cancelled in Firestore`
        );
      } else {
        const res = await fetch(`/api/purchase-orders/${poId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-tenant-id': activeTenantId,
          },
          body: JSON.stringify({ status }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Could not update PO', true);
          return;
        }
        setTenantState(data.state);
        showToast(`Purchase order ${poId} marked ${status}`);
      }
    } catch {
      showToast('Failed to update purchase order', true);
    }
  };

  const handleProvisionTenant = async () => {
    if (!newTenantName.trim() || !newTenantCode.trim()) {
      showToast('Enter tenant organization name and code', true);
      return;
    }
    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-tenant-id': activeTenantId,
        },
        body: JSON.stringify({
          name: newTenantName,
          code: newTenantCode,
          region: newTenantRegion,
          currencySymbol: newTenantCurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to provision tenant', true);
        return;
      }
      setTenants(data.tenants);
      seedTemplateRef.current = data.state;
      setFirestoreSynced(false);
      setActiveTenantId(data.tenant.id);
      setTenantState(data.state);
      setNewTenantName('');
      setNewTenantCode('');
      if (fbUser && data.tenant && data.state) {
        await persistNewTenantToFirestore(
          fbUser.uid,
          fbUser.email || user?.email || 'authenticated@supplychain.io',
          data.tenant,
          data.state
        );
      }
      showToast(`Provisioned tenant ${data.tenant.name}`);
    } catch {
      showToast('Failed to provision tenant', true);
    }
  };

  const unreadNotifCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const renderStatusLabel = (text: string, colorCode: 'r' | 'o' | 'g' | 'b') => {
    const colorClasses = {
      g: 'text-[#22c55e]',
      o: 'text-[#f59e0b]',
      r: 'text-[#ff5560]',
      b: 'text-[#d4d4d4]',
    }[colorCode];
    return <span className={`font-semibold text-xs ${colorClasses}`}>{text}</span>;
  };

  const renderSampleBadge = (isSample?: boolean) => {
    if (isSample) {
      return (
        <span className="ml-1.5 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#262626] text-[#9b9b9b]">
          Sample
        </span>
      );
    }
    return (
      <span className="ml-1.5 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#14291a] text-[#22c55e]">
        Live
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f2f2f2] grid grid-cols-1 lg:grid-cols-[240px_1fr]">
      {/* Left Sidebar Navigation */}
      <aside className="bg-[#050505] border-b lg:border-b-0 lg:border-r border-[#262626] p-4 flex lg:flex-col items-center lg:items-stretch gap-3 overflow-x-auto">
        <div className="font-bold text-base tracking-tight whitespace-nowrap shrink-0 lg:mb-4 lg:px-2 flex items-center justify-between">
          <span>
            Supply<b className="text-[#e11d2e]">Chain</b> Optimizer
          </span>
        </div>

        {/* Multi-Tenant Workspace Selector */}
        <div className="hidden lg:block mb-3 px-1">
          <label className="block text-[11px] text-[#9b9b9b] mb-1">
            Active Tenant Workspace
          </label>
          <select
            value={activeTenantId}
            onChange={(e) => handleTenantChange(e.target.value)}
            className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs text-[#f2f2f2] focus:outline-2 focus:outline-[#7f1d1d]"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} · {t.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="flex lg:flex-col gap-1.5 shrink-0">
          {PAGES.map(([key, label]) => {
            const isActive = activePage === key;
            return (
              <button
                key={key}
                onClick={() => navigateTo(key)}
                className={`text-left px-3 py-2 rounded-lg text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-[#e11d2e] text-white font-semibold'
                    : 'text-[#9b9b9b] hover:text-[#f2f2f2] hover:bg-[#161616]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>

        {/* Bottom Firestore Cloud Persistence & RBAC Switcher */}
        <div className="hidden lg:flex flex-col gap-2.5 mt-auto pt-4 border-t border-[#262626] px-1 text-xs">
          <div className="bg-[#0d0d0d] border border-[#262626] rounded-lg p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-[#f2f2f2] flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-[#e11d2e]" />
                Cloud Firestore
              </span>
              <span
                className={`font-mono text-[11px] ${
                  firestoreLoading
                    ? 'text-[#f59e0b]'
                    : firestoreSynced
                    ? 'text-[#22c55e]'
                    : 'text-[#f59e0b]'
                }`}
              >
                {firestoreLoading ? 'Syncing...' : firestoreSynced ? 'Live Sync' : 'Sign-In Needed'}
              </span>
            </div>
            {fbUser ? (
              <div className="space-y-1.5">
                <div className="text-[11px] text-[#9b9b9b] truncate font-mono">
                  {fbUser.email}
                </div>
                <button
                  onClick={handleFirebaseSignOut}
                  className="w-full border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded px-2 py-1 text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <LogOut className="w-3 h-3" /> Sign Out
                </button>
              </div>
            ) : (
              <button
                onClick={handleFirebaseGoogleSignIn}
                className="w-full bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded px-2.5 py-1.5 text-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" /> Sign in with Google
              </button>
            )}
          </div>

          <div className="flex items-center justify-between text-[#9b9b9b]">
            <span>Real-time WS Stream</span>
            <span className="font-mono text-[11px] text-[#f2f2f2]">
              {wsConnected ? `Connected (${presence.length})` : 'Reconnecting'}
            </span>
          </div>

          {user && (
            <div className="bg-[#0d0d0d] border border-[#262626] rounded-lg p-2.5">
              <div className="font-semibold text-[#f2f2f2] truncate">
                {fbUser?.displayName || user.name}
              </div>
              <div className="text-[11px] text-[#9b9b9b] truncate mb-2">
                {fbUser?.email || user.email} ·{' '}
                <span className="text-[#ff5560] font-mono">{user.role}</span>
              </div>
              <label className="block text-[11px] text-[#9b9b9b] mb-1">
                Switch Role (Live RBAC Test)
              </label>
              <select
                value={user.role}
                onChange={(e) =>
                  handleSwitchUserOrRole(user.id, e.target.value as UserRole)
                }
                className="w-full bg-[#141414] border border-[#262626] rounded px-2 py-1 text-xs text-[#f2f2f2]"
              >
                <option value="SUPER_ADMIN">SUPER_ADMIN (Full Access)</option>
                <option value="OPS_MANAGER">OPS_MANAGER (No Delete/Tenants)</option>
                <option value="INVENTORY_ANALYST">INVENTORY_ANALYST (Ledger Only)</option>
                <option value="AUDITOR">AUDITOR (Read-Only + Exports)</option>
              </select>
            </div>
          )}

          <div className="pt-2 border-t border-[#262626] text-[11px] text-[#9b9b9b] leading-snug">
            <div className="font-semibold text-[#f2f2f2]">Mohan Babu University (MBU)</div>
            <div>Narasimha · Akhilesh · Yuvaraj · Shaheen</div>
          </div>
        </div>
      </aside>

      {/* Main Content Viewport */}
      <main className="p-5 lg:p-6 min-w-0 max-w-[1600px]">
        {/* Top Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 mb-4 pb-3 border-b border-[#262626] relative">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">
              {PAGES.find((p) => p[0] === activePage)?.[1]}
            </h1>
            <span className="text-xs text-[#9b9b9b] hidden sm:inline">
              · {tenantState?.tenant.name} ({tenantState?.tenant.region}) · Firestore:{' '}
              <strong
                className={`font-mono ${
                  firestoreLoading
                    ? 'text-[#f59e0b]'
                    : firestoreSynced
                    ? 'text-[#22c55e]'
                    : 'text-[#f59e0b]'
                }`}
              >
                {firestoreLoading
                  ? 'LOADING...'
                  : firestoreSynced
                  ? 'PERSISTENT (mystical-logic-zdtd0)'
                  : 'DEMO PREVIEW (SIGN IN TO PERSIST)'}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {!fbUser && (
              <button
                onClick={handleFirebaseGoogleSignIn}
                className="bg-[#e11d2e] hover:bg-[#c3101f] text-white rounded-lg px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                <LogIn className="w-3.5 h-3.5" />
                Sign in with Google (Firestore)
              </button>
            )}

            {/* Notifications Drawer Toggle */}
            <button
              onClick={() => setNotifOpen((prev) => !prev)}
              className="bg-[#141414] hover:bg-[#1f1f1f] text-[#f2f2f2] border border-[#262626] rounded-lg px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Bell className="w-3.5 h-3.5 text-[#e11d2e]" />
              Alerts
              {unreadNotifCount > 0 && (
                <span className="bg-[#e11d2e] text-white font-mono text-[10px] px-1.5 py-0.2 rounded">
                  {unreadNotifCount}
                </span>
              )}
            </button>

            <button
              onClick={handleDownloadCsvFile}
              className="bg-[#141414] hover:bg-[#1f1f1f] text-[#f2f2f2] border border-[#262626] rounded-lg px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-[#e11d2e]" />
              Export CSV Report
            </button>
          </div>

          {/* Notifications Dropdown Panel */}
          {notifOpen && (
            <div className="absolute right-0 top-12 w-96 max-w-full bg-[#141414] border border-[#262626] rounded-xl p-3.5 shadow-2xl z-30">
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-[#262626]">
                <span className="text-xs font-semibold">
                  Firestore Notifications ({notifications.length})
                </span>
                <button
                  onClick={() => setNotifOpen(false)}
                  className="text-xs text-[#9b9b9b] hover:text-[#f2f2f2] cursor-pointer"
                >
                  Close
                </button>
              </div>
              {notifications.length === 0 ? (
                <div className="text-xs text-[#9b9b9b] py-4 text-center">
                  No active stock or order notifications.
                </div>
              ) : (
                <ul className="divide-y divide-[#262626] max-h-64 overflow-y-auto text-xs">
                  {notifications.slice(0, 12).map((n) => (
                    <li key={n.id} className="py-2 flex items-start justify-between gap-2">
                      <div>
                        <span
                          className={`font-mono text-[10px] mr-1.5 ${
                            n.type === 'OUT_OF_STOCK'
                              ? 'text-[#ff5560]'
                              : n.type === 'LOW_STOCK'
                              ? 'text-[#f59e0b]'
                              : 'text-[#22c55e]'
                          }`}
                        >
                          [{n.type}]
                        </span>
                        <span className={n.read ? 'text-[#9b9b9b]' : 'text-[#f2f2f2] font-medium'}>
                          {n.message}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!n.read && fbUser && (
                          <button
                            onClick={() => markNotificationReadInFirestore(activeTenantId, n.id)}
                            className="text-[10px] text-[#22c55e] hover:underline cursor-pointer"
                          >
                            Read
                          </button>
                        )}
                        {fbUser && (
                          <button
                            onClick={() => deleteNotificationFromFirestore(activeTenantId, n.id)}
                            className="text-[10px] text-[#ff5560] hover:underline cursor-pointer"
                          >
                            Del
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </header>

        {/* Top Progress Transition Bar */}
        <div
          className="h-[3px] bg-[#e11d2e] rounded-xs mb-4 transition-all duration-300"
          style={{ width: barLoading || firestoreLoading ? '100%' : '0%' }}
        />

        {/* Firestore Status / Error Banner */}
        {firestoreError && (
          <div className="mb-4 bg-[#2a0f12] border border-[#ff5560] rounded-xl p-3 text-xs text-[#ff5560] flex items-center justify-between">
            <span>Firestore Error: {firestoreError}</span>
            <button
              onClick={() => setFirestoreError(null)}
              className="underline ml-3 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {!fbUser && (
          <div className="mb-4 bg-[#141414] border border-[#262626] rounded-xl p-3 text-xs text-[#d4d4d4] flex flex-wrap items-center justify-between gap-2">
            <span>
              Viewing <b className="text-[#f2f2f2]">Sample / Demo Data</b>. Sign in with Google to
              connect to Cloud Firestore (<code className="font-mono">{firebaseConfig.projectId}</code>) so all additions, edits, and deletions persist across browser refreshes.
            </span>
            <button
              onClick={handleFirebaseGoogleSignIn}
              className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-md px-3 py-1 text-xs cursor-pointer"
            >
              Sign in with Google
            </button>
          </div>
        )}

        {/* SECTION 1: DASHBOARD */}
        {activePage === 'dash' && (
          <section className="space-y-4">
            {/* 6 KPI Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3.5">
              {[
                { label: 'Total Products', val: products.length, alert: false },
                { label: 'Total Suppliers', val: suppliers.length, alert: false },
                { label: 'Inventory Value', val: fmtCurr(totalInventoryValue), alert: false },
                {
                  label: 'Below Reorder Point',
                  val: lowStockCount + outOfStockCount,
                  alert: true,
                },
                { label: 'Potential Stockout Risks', val: stockoutCount, alert: true },
                { label: 'Potential Excess Risks', val: excessCount, alert: false },
              ].map((kpi) => (
                <div
                  key={kpi.label}
                  className={`bg-[#141414] border rounded-xl p-4 ${
                    kpi.alert ? 'border-[#7f1d1d]' : 'border-[#262626]'
                  }`}
                >
                  <b
                    className={`block text-2xl font-mono tabular-nums ${
                      kpi.alert ? 'text-[#ff5560]' : 'text-[#f2f2f2]'
                    }`}
                  >
                    {kpi.val}
                  </b>
                  <span className="text-xs text-[#9b9b9b]">{kpi.label}</span>
                </div>
              ))}
            </div>

            {/* Row 2: Inventory Overview + D3 Donut & Demand Analysis D3 Chart */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold mb-2.5">Inventory Overview</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
                  {[
                    [
                      'Units in stock',
                      totalInventoryUnits.toLocaleString(currencyLocale),
                    ],
                    ['Low-stock products', lowStockCount],
                    ['Out-of-stock products', outOfStockCount],
                    ['Inventory value', fmtCurr(totalInventoryValue)],
                  ].map(([lbl, val]) => (
                    <div key={String(lbl)} className="bg-[#0d0d0d] rounded-lg p-2.5">
                      <b className="block text-lg font-mono tabular-nums">{val}</b>
                      <span className="text-xs text-[#9b9b9b]">{lbl}</span>
                    </div>
                  ))}
                </div>
                <D3InventoryDonut counts={donutCounts} />
              </div>

              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                  <h2 className="text-[15px] font-semibold">Demand Analysis (90 days)</h2>
                  <div className="flex items-center gap-2">
                    <select
                      value={demProductFilter}
                      onChange={(e) => setDemProductFilter(e.target.value)}
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1 text-xs text-[#f2f2f2]"
                    >
                      <option value="all">All products</option>
                      {products.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.productName || p.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={demMode}
                      onChange={(e) => setDemMode(e.target.value as 'd' | 'm')}
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1 text-xs text-[#f2f2f2]"
                    >
                      <option value="d">Daily</option>
                      <option value="m">Monthly</option>
                    </select>
                  </div>
                </div>
                <D3DemandChart
                  labels={demandChartData.labels}
                  values={demandChartData.values}
                  mode={demMode}
                />
              </div>
            </div>

            {/* Row 3: Supplier Summary + Recent Real-Time Activity Stream */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold mb-2.5">Supplier Summary</h2>
                <div className="grid grid-cols-3 gap-2.5 mb-4">
                  <div className="bg-[#0d0d0d] rounded-lg p-2.5">
                    <b className="block text-lg font-mono tabular-nums">
                      {supplierSummary.totalPos}
                    </b>
                    <span className="text-xs text-[#9b9b9b]">Total POs</span>
                  </div>
                  <div className="bg-[#0d0d0d] rounded-lg p-2.5">
                    <b className="block text-lg font-mono tabular-nums">
                      {supplierSummary.onTimeStr}
                    </b>
                    <span className="text-xs text-[#9b9b9b]">On-time delivery</span>
                  </div>
                  <div className="bg-[#0d0d0d] rounded-lg p-2.5">
                    <b className="block text-lg font-mono tabular-nums">
                      {supplierSummary.avgDelayStr}
                    </b>
                    <span className="text-xs text-[#9b9b9b]">Avg delay</span>
                  </div>
                </div>
                <D3SupplierBarChart
                  suppliers={supplierMetrics.map((m) => ({
                    name: m.supplier.name,
                    onTimePct: m.ont || 0,
                  }))}
                />
              </div>

              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <div className="flex items-center justify-between mb-2.5">
                  <h2 className="text-[15px] font-semibold">
                    Recent Real-Time Activity Stream
                  </h2>
                  <button
                    onClick={() => navigateTo('sec')}
                    className="text-xs text-[#ff5560] hover:underline cursor-pointer"
                  >
                    Full Security Audit Log →
                  </button>
                </div>
                <ul className="divide-y divide-[#262626] text-sm">
                  {auditLogs
                    .slice()
                    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.n - a.n))
                    .slice(0, 8)
                    .map((a) => (
                      <li
                        key={a.id}
                        className="py-2 flex flex-wrap items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-xs text-[#d4d4d4] font-semibold">
                            {a.k}
                          </span>
                          <span className="text-[#9b9b9b]">·</span>
                          <span className="text-[#f2f2f2] truncate">{a.m}</span>
                        </div>
                        <span className="text-xs font-mono text-[#9b9b9b] tabular-nums shrink-0">
                          {a.d}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </div>

            {/* Row 4: Low-Stock Alerts */}
            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <h2 className="text-[15px] font-semibold mb-2.5">Low-Stock Alerts</h2>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">Product</th>
                      <th className="py-2 px-2 text-left font-semibold">Warehouse</th>
                      <th className="py-2 px-2 text-right font-semibold">Stock</th>
                      <th className="py-2 px-2 text-right font-semibold">Reorder point</th>
                      <th className="py-2 px-2 text-left font-semibold">Status</th>
                      <th className="py-2 px-2 text-left font-semibold">Supplier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {products
                      .filter((p) => getStockStatus(p, transactions)[2] !== 'ok')
                      .map((p) => {
                        const st = getStockStatus(p, transactions);
                        const supName =
                          suppliers.find((s) => s.id === p.sup)?.name || 'Unknown';
                        return (
                          <tr key={p.id} className="hover:bg-[#1a1a1a]">
                            <td className="py-2.5 px-2 font-medium">
                              {p.productName || p.name}
                              {renderSampleBadge(p.isSample)}
                            </td>
                            <td className="py-2.5 px-2 font-mono text-xs text-[#9b9b9b]">
                              {getWarehouseForProduct(p.id)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {getStock(p, transactions)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {p.lowStockThreshold ?? p.rop}
                            </td>
                            <td className="py-2.5 px-2">
                              {renderStatusLabel(st[0], st[1])}
                            </td>
                            <td className="py-2.5 px-2 text-[#b5b5b5]">{supName}</td>
                          </tr>
                        );
                      })}
                    {products.filter((p) => getStockStatus(p, transactions)[2] !== 'ok')
                      .length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-4 text-center text-[#9b9b9b]">
                          No low-stock alerts. All SKUs are healthy.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 2: PRODUCTS & SUPPLIERS CATALOG */}
        {activePage === 'prod' && (
          <section className="space-y-4">
            {/* Products Catalog Card */}
            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-2.5 mb-3.5">
                <div className="relative">
                  <Search className="w-4 h-4 text-[#9b9b9b] absolute left-3 top-2.5" />
                  <input
                    value={prodQuery}
                    onChange={(e) => {
                      setProdQuery(e.target.value);
                      setProdPage(1);
                    }}
                    placeholder="Search name, SKU, or category"
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg pl-9 pr-3 py-1.5 text-sm text-[#f2f2f2] focus:outline-2 focus:outline-[#7f1d1d]"
                  />
                </div>
                <select
                  value={prodCategoryFilter}
                  onChange={(e) => {
                    setProdCategoryFilter(e.target.value);
                    setProdPage(1);
                  }}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                >
                  <option value="all">All categories</option>
                  {availableCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <select
                  value={prodStatusFilter}
                  onChange={(e) => {
                    setProdStatusFilter(e.target.value as 'all' | 'ok' | 'low' | 'out');
                    setProdPage(1);
                  }}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                >
                  <option value="all">All statuses</option>
                  <option value="ok">Healthy / In Stock</option>
                  <option value="low">Low</option>
                  <option value="out">Out of stock</option>
                </select>
                <select
                  value={prodSort}
                  onChange={(e) => setProdSort(e.target.value as 'name' | 'qty' | 'val')}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                >
                  <option value="name">Sort: name</option>
                  <option value="qty">Sort: quantity</option>
                  <option value="val">Sort: inventory value</option>
                </select>

                <div className="ml-auto flex items-center gap-2">
                  {products.length === 0 && fbUser && (
                    <button
                      onClick={handleReloadSampleData}
                      className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Load Sample Data
                    </button>
                  )}
                  <button
                    onClick={() => openProductModal()}
                    className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3.5 py-1.5 text-sm flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-4 h-4" /> Add Product
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">ID</th>
                      <th className="py-2 px-2 text-left font-semibold">SKU</th>
                      <th className="py-2 px-2 text-left font-semibold">Product Name</th>
                      <th className="py-2 px-2 text-left font-semibold">Category & Warehouse</th>
                      <th className="py-2 px-2 text-right font-semibold">Unit Cost</th>
                      <th className="py-2 px-2 text-right font-semibold">Selling Price</th>
                      <th className="py-2 px-2 text-right font-semibold">Current Stock</th>
                      <th className="py-2 px-2 text-right font-semibold">Reorder Point</th>
                      <th className="py-2 px-2 text-left font-semibold">Stock Status</th>
                      <th className="py-2 px-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {filteredProducts
                      .slice((safeProdPage - 1) * 6, safeProdPage * 6)
                      .map((p) => {
                        const st = getStockStatus(p, transactions);
                        const curStock = getStock(p, transactions);
                        const pCost = p.purchaseCost ?? p.cost;
                        const sPrice = p.sellingPrice ?? Math.round(pCost * 1.25);
                        return (
                          <tr key={p.id} className="hover:bg-[#1a1a1a]">
                            <td className="py-2.5 px-2 font-mono text-xs text-[#9b9b9b] tabular-nums">
                              {formatProductId(p.id, p.productId)}
                            </td>
                            <td className="py-2.5 px-2 font-mono text-xs">{p.sku}</td>
                            <td className="py-2.5 px-2 font-medium">
                              {p.productName || p.name}
                              {renderSampleBadge(p.isSample)}
                            </td>
                            <td className="py-2.5 px-2 text-xs text-[#9b9b9b]">
                              <div>{p.category || 'General Electronics'}</div>
                              <div className="font-mono text-[11px]">
                                {getWarehouseForProduct(p.id)}
                              </div>
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {fmtCurr(pCost)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums text-[#22c55e]">
                              {fmtCurr(sPrice)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {curStock} {p.unit || 'units'}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {p.lowStockThreshold ?? p.rop}
                            </td>
                            <td className="py-2.5 px-2">
                              {renderStatusLabel(st[0], st[1])}
                            </td>
                            <td className="py-2.5 px-2 text-right space-x-1.5 whitespace-nowrap">
                              <button
                                onClick={() => setViewingProduct(p)}
                                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-md px-2.5 py-1 text-xs cursor-pointer"
                              >
                                View
                              </button>
                              <button
                                onClick={() => openProductModal(p)}
                                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-md px-2.5 py-1 text-xs cursor-pointer"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => setDeletingProduct(p)}
                                className="border border-[#262626] hover:bg-[#3a1015] text-[#ff5560] rounded-md px-2.5 py-1 text-xs cursor-pointer"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    {filteredProducts.length === 0 && (
                      <tr>
                        <td colSpan={10} className="py-6 text-center text-[#9b9b9b]">
                          No products match your filter criteria.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-end gap-2.5 mt-3 text-xs">
                <span className="text-[#9b9b9b] font-mono tabular-nums">
                  {filteredProducts.length} records · page {safeProdPage} of {prodTotalPages}
                </span>
                <button
                  disabled={safeProdPage <= 1}
                  onClick={() => setProdPage((p) => Math.max(1, p - 1))}
                  className="border border-[#262626] disabled:opacity-40 rounded-md px-2.5 py-1 text-[#f2f2f2] cursor-pointer"
                >
                  Prev
                </button>
                <button
                  disabled={safeProdPage >= prodTotalPages}
                  onClick={() => setProdPage((p) => Math.min(prodTotalPages, p + 1))}
                  className="border border-[#262626] disabled:opacity-40 rounded-md px-2.5 py-1 text-[#f2f2f2] cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>

            {/* Suppliers Directory Card (Connected to `suppliers` Firestore collection) */}
            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-[15px] font-semibold">
                    Suppliers Directory (Firestore `suppliers` Collection)
                  </h2>
                  <p className="text-xs text-[#9b9b9b]">
                    Manage approved supply chain vendors, contact details, and status.
                  </p>
                </div>
                <button
                  onClick={() =>
                    setEditingSupplier({
                      id: 0,
                      name: '',
                      contactPerson: '',
                      email: '',
                      phone: '',
                      address: '',
                      status: 'ACTIVE',
                    })
                  }
                  className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Supplier
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[680px] text-xs">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b]">
                      <th className="py-2 px-2 text-left">ID</th>
                      <th className="py-2 px-2 text-left">Supplier Name</th>
                      <th className="py-2 px-2 text-left">Contact Person</th>
                      <th className="py-2 px-2 text-left">Email & Phone</th>
                      <th className="py-2 px-2 text-left">Address</th>
                      <th className="py-2 px-2 text-left">Status</th>
                      <th className="py-2 px-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {suppliers.map((s) => (
                      <tr key={s.id} className="hover:bg-[#1a1a1a]">
                        <td className="py-2 px-2 font-mono text-[#9b9b9b]">#{s.id}</td>
                        <td className="py-2 px-2 font-medium text-[#f2f2f2]">
                          {s.name}
                          {renderSampleBadge(s.isSample)}
                        </td>
                        <td className="py-2 px-2 text-[#d4d4d4]">
                          {s.contactPerson || 'Operations Desk'}
                        </td>
                        <td className="py-2 px-2 font-mono text-[#9b9b9b]">
                          <div>{s.email || 'orders@supplier.io'}</div>
                          <div>{s.phone || '+91-80-4000-0000'}</div>
                        </td>
                        <td className="py-2 px-2 text-[#9b9b9b]">
                          {s.address || 'Bengaluru Logistics Park'}
                        </td>
                        <td className="py-2 px-2">
                          {renderStatusLabel(
                            s.status || 'ACTIVE',
                            s.status === 'INACTIVE'
                              ? 'r'
                              : s.status === 'ON_HOLD'
                              ? 'o'
                              : 'g'
                          )}
                        </td>
                        <td className="py-2 px-2 text-right space-x-1.5">
                          <button
                            onClick={() =>
                              setEditingSupplier({
                                id: s.id,
                                name: s.name,
                                contactPerson: s.contactPerson || 'Operations Desk',
                                email: s.email || 'orders@supplier.io',
                                phone: s.phone || '+91-80-4000-0000',
                                address: s.address || 'Bengaluru Logistics Park',
                                status: s.status || 'ACTIVE',
                              })
                            }
                            className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded px-2 py-0.5 cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteSupplier(s)}
                            className="border border-[#262626] hover:bg-[#3a1015] text-[#ff5560] rounded px-2 py-0.5 cursor-pointer"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 3: INVENTORY LEDGER */}
        {activePage === 'inv' && (
          <section className="space-y-4">
            <div className="bg-[#120a0b] border border-[#262626] rounded-lg p-3 text-xs text-[#d8d8d8]">
              Ledger: Current Stock = Opening Stock + IN − OUT + adjustments. OUT is stored as a negative quantity and each adjustment as one signed quantity, so nothing is counted twice. Stock is derived from the ledger, so the balance and the transaction can never disagree.
            </div>

            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <h2 className="text-[15px] font-semibold mb-3">Record Transaction</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">Product</label>
                  <select
                    value={txPid}
                    onChange={(e) => setTxPid(Number(e.target.value))}
                    className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.productName || p.name} ({p.sku})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">Type</label>
                  <select
                    value={txType}
                    onChange={(e) => setTxType(e.target.value as 'IN' | 'OUT' | 'ADJUST')}
                    className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                  >
                    <option value="IN">IN</option>
                    <option value="OUT">OUT</option>
                    <option value="ADJUST">ADJUST</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">
                    Quantity (ADJUST: use + or −)
                  </label>
                  <input
                    type="number"
                    step="1"
                    value={txQty}
                    onChange={(e) => setTxQty(e.target.value)}
                    placeholder="e.g. 25"
                    className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">Date</label>
                  <input
                    type="date"
                    value={txDate}
                    onChange={(e) => setTxDate(e.target.value)}
                    className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">
                    Related Order ID (Optional)
                  </label>
                  <input
                    value={txOrderId}
                    onChange={(e) => setTxOrderId(e.target.value)}
                    placeholder="e.g. PO-1012 / SO-204"
                    className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2] font-mono"
                  />
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-xs text-[#9b9b9b] mb-1">Notes</label>
                <input
                  value={txNote}
                  onChange={(e) => setTxNote(e.target.value)}
                  maxLength={120}
                  placeholder="Supplier delivery reference or cycle count note"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                />
              </div>

              {txWarning && (
                <div className="text-xs text-[#ff5560] mb-2.5 font-medium">{txWarning}</div>
              )}

              <button
                disabled={isSubmittingTx || Boolean(txWarning)}
                onClick={handleSaveTransaction}
                className="bg-[#e11d2e] hover:bg-[#c3101f] disabled:opacity-40 text-white font-semibold rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                {isSubmittingTx ? 'Saving...' : 'Save Transaction'}
              </button>
            </div>

            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <h2 className="text-[15px] font-semibold mb-3">Transaction History</h2>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <select
                  value={invProdFilter}
                  onChange={(e) => {
                    setInvProdFilter(e.target.value);
                    setInvPage(1);
                  }}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                >
                  <option value="all">All products</option>
                  {products.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.productName || p.name}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  value={invFromDate}
                  onChange={(e) => {
                    setInvFromDate(e.target.value);
                    setInvPage(1);
                  }}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2] font-mono"
                />
                <input
                  type="date"
                  value={invToDate}
                  onChange={(e) => {
                    setInvToDate(e.target.value);
                    setInvPage(1);
                  }}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2] font-mono"
                />
                <input
                  value={invSearch}
                  onChange={(e) => {
                    setInvSearch(e.target.value);
                    setInvPage(1);
                  }}
                  placeholder="Search notes or product"
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
                {[
                  [
                    'Total IN',
                    sum(filteredTransactions.filter((t) => t.type === 'IN').map((t) => t.qty)),
                  ],
                  [
                    'Total OUT',
                    sum(filteredTransactions.filter((t) => t.type === 'OUT').map((t) => t.qty)),
                  ],
                  [
                    'Net adjustments',
                    sum(
                      filteredTransactions.filter((t) => t.type === 'ADJUST').map((t) => t.qty)
                    ),
                  ],
                  ['Transactions', filteredTransactions.length],
                ].map(([lbl, val]) => (
                  <div key={String(lbl)} className="bg-[#0d0d0d] rounded-lg p-2.5">
                    <b className="block text-lg font-mono tabular-nums">{val}</b>
                    <span className="text-xs text-[#9b9b9b]">{lbl}</span>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">ID</th>
                      <th className="py-2 px-2 text-left font-semibold">Product</th>
                      <th className="py-2 px-2 text-left font-semibold">Date</th>
                      <th className="py-2 px-2 text-left font-semibold">Type</th>
                      <th className="py-2 px-2 text-right font-semibold">Qty</th>
                      <th className="py-2 px-2 text-right font-semibold">Resulting Stock</th>
                      <th className="py-2 px-2 text-left font-semibold">Order Ref</th>
                      <th className="py-2 px-2 text-left font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {filteredTransactions
                      .slice((safeInvPage - 1) * 8, safeInvPage * 8)
                      .map((t) => {
                        const resStock =
                          t.resultingStock !== undefined
                            ? t.resultingStock
                            : computedResultingStockMap[t.id] ?? 0;
                        return (
                          <tr key={t.id} className="hover:bg-[#1a1a1a]">
                            <td className="py-2.5 px-2 font-mono text-xs text-[#9b9b9b] tabular-nums">
                              #{t.id}
                            </td>
                            <td className="py-2.5 px-2 font-medium">
                              {t.productName || getProductName(t.pid)}
                              {renderSampleBadge(t.isSample)}
                            </td>
                            <td className="py-2.5 px-2 font-mono text-xs tabular-nums">
                              {t.date}
                            </td>
                            <td className="py-2.5 px-2">
                              {renderStatusLabel(
                                t.type,
                                t.type === 'IN' ? 'g' : t.type === 'OUT' ? 'r' : 'o'
                              )}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {t.qty > 0 ? `+${t.qty}` : t.qty}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {resStock}
                            </td>
                            <td className="py-2.5 px-2 font-mono text-xs text-[#9b9b9b]">
                              {t.relatedOrderId || '-'}
                            </td>
                            <td className="py-2.5 px-2 text-xs text-[#b5b5b5]">{t.note}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-end gap-2.5 mt-3 text-xs">
                <span className="text-[#9b9b9b] font-mono tabular-nums">
                  {filteredTransactions.length} records · page {safeInvPage} of {invTotalPages}
                </span>
                <button
                  disabled={safeInvPage <= 1}
                  onClick={() => setInvPage((p) => Math.max(1, p - 1))}
                  className="border border-[#262626] disabled:opacity-40 rounded-md px-2.5 py-1 text-[#f2f2f2] cursor-pointer"
                >
                  Prev
                </button>
                <button
                  disabled={safeInvPage >= invTotalPages}
                  onClick={() => setInvPage((p) => Math.min(invTotalPages, p + 1))}
                  className="border border-[#262626] disabled:opacity-40 rounded-md px-2.5 py-1 text-[#f2f2f2] cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 4: ANALYTICS & FORECASTING */}
        {activePage === 'ana' && (
          <section className="space-y-4">
            <div className="bg-[#120a0b] border border-[#262626] rounded-lg p-3 text-xs text-[#d8d8d8]">
              Reorder Point = Average Daily Demand × Lead Time (days) + Safety Stock. Units: demand = units/day, lead time = days, stock = units. Incoming stock counts only pending orders due within the lead time. Delivery delay = receipt date − expected date (negative = early). On-time % = on-time ÷ received orders; pending and cancelled orders are excluded. Forecasts are estimates, not guarantees.
            </div>

            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-4 mb-3 text-sm">
                <label className="flex items-center gap-2">
                  <span className="text-[#9b9b9b]">Demand window</span>
                  <select
                    value={anaWindow}
                    onChange={(e) => setAnaWindow(Number(e.target.value))}
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1 text-sm text-[#f2f2f2]"
                  >
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                  </select>
                </label>

                <label className="flex items-center gap-2">
                  <span className="text-[#9b9b9b]">Excess threshold (days of demand)</span>
                  <input
                    type="number"
                    min={1}
                    value={anaExcessThreshold}
                    onChange={(e) => setAnaExcessThreshold(Number(e.target.value))}
                    className="w-20 bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1 text-sm text-[#f2f2f2] font-mono"
                  />
                </label>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">Product</th>
                      <th className="py-2 px-2 text-right font-semibold">Stock</th>
                      <th className="py-2 px-2 text-right font-semibold">Avg/day</th>
                      <th className="py-2 px-2 text-right font-semibold">Lead</th>
                      <th className="py-2 px-2 text-right font-semibold">Safety</th>
                      <th className="py-2 px-2 text-right font-semibold">ROP</th>
                      <th className="py-2 px-2 text-right font-semibold">Days left</th>
                      <th className="py-2 px-2 text-left font-semibold">Risk</th>
                      <th className="py-2 px-2 text-left font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {anaCalculations.map((c) => (
                      <tr key={c.p.id} className="hover:bg-[#1a1a1a]">
                        <td className="py-2.5 px-2 font-medium">{c.p.name}</td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {c.s}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {c.a.toFixed(1)}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {c.p.lead}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {c.p.safety}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {c.rop}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {isFinite(c.days) ? c.days.toFixed(0) : 'n/a'}
                        </td>
                        <td className="py-2.5 px-2">
                          {renderStatusLabel(c.risk[0], c.risk[1])}
                        </td>
                        <td className="py-2.5 px-2 text-xs text-[#b5b5b5]">{c.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold mb-2">
                  Stock vs Reorder Point (D3.js Log Scale)
                </h2>
                <D3StockVsRopChart
                  items={anaCalculations.map((c) => ({
                    name: c.p.name,
                    stock: c.s,
                    rop: c.rop,
                  }))}
                />
              </div>
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold mb-2">
                  Inventory Value by Product ({currencySymbol})
                </h2>
                <D3InventoryValueChart
                  items={products.map((p) => ({
                    name: p.name,
                    value: getStock(p, transactions) * p.cost,
                  }))}
                  currencySymbol={currencySymbol}
                  currencyLocale={currencyLocale}
                />
              </div>
            </div>

            {forecastEval && (
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div>
                    <h2 className="text-[15px] font-semibold">
                      Demand Forecast (Firestore `forecasts` Collection)
                    </h2>
                    {forecastEval.savedDoc && (
                      <div className="text-[11px] text-[#9b9b9b] font-mono">
                        Saved in Firestore: {forecastEval.savedDoc.method} · Predicted{' '}
                        {forecastEval.savedDoc.predictedDailyDemand}/day (14d Total:{' '}
                        {forecastEval.savedDoc.projectedPeriodTotal} units)
                        {renderSampleBadge(forecastEval.savedDoc.isSample)}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={anaForecastPid}
                      onChange={(e) => setAnaForecastPid(Number(e.target.value))}
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                    >
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.sku})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleSaveForecast}
                      className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" /> Save Forecast to Firestore
                    </button>
                  </div>
                </div>
                <D3ForecastChart
                  histDates={forecastEval.histDates}
                  histValues={forecastEval.histValues}
                  forecastDates={forecastEval.forecastDates}
                  forecastValue={forecastEval.base}
                />
                <div className="text-xs text-[#9b9b9b] mt-2 leading-relaxed">
                  Model: baseline = mean of the last {anaWindow} days ={' '}
                  <b className="text-[#f2f2f2] font-mono">
                    {forecastEval.base.toFixed(1)} units/day
                  </b>
                  , shown for the next 14 days. Evaluation: time-based split (train = first{' '}
                  {forecastEval.trLen} days, test = last {forecastEval.H} days). MAE of mean
                  baseline{' '}
                  <b className="text-[#f2f2f2] font-mono">
                    {forecastEval.maeMean.toFixed(2)}
                  </b>{' '}
                  vs last-value naive{' '}
                  <b className="text-[#f2f2f2] font-mono">
                    {forecastEval.maeNaive.toFixed(2)}
                  </b>{' '}
                  units/day.{' '}
                  {forecastEval.maeMean <= forecastEval.maeNaive
                    ? 'The mean baseline did better on this test.'
                    : 'The naive method did better on this test.'}{' '}
                  Forecasts are estimates, not guarantees.
                </div>
              </div>
            )}

            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <h2 className="text-[15px] font-semibold mb-3">
                Supplier Delivery Performance & Active Purchase Orders (`purchaseOrders` Collection)
              </h2>
              <div className="overflow-x-auto mb-4">
                <table className="w-full border-collapse min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">Supplier</th>
                      <th className="py-2 px-2 text-right font-semibold">Total POs</th>
                      <th className="py-2 px-2 text-right font-semibold">Completed</th>
                      <th className="py-2 px-2 text-right font-semibold">On-time %</th>
                      <th className="py-2 px-2 text-right font-semibold">
                        Avg delay (days)
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {supplierMetrics.map((m) => (
                      <tr key={m.supplier.id} className="hover:bg-[#1a1a1a]">
                        <td className="py-2.5 px-2 font-medium">{m.supplier.name}</td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {m.total}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {m.done}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {m.ont === null
                            ? 'n/a'
                            : `${m.ont}% (${m.dl.filter((d) => d <= 0).length}/${m.done})`}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                          {m.delay === null ? 'n/a' : m.delay.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="text-xs font-semibold text-[#9b9b9b] mb-2">
                Purchase Order Queue (Receive pending POs to credit stock ledger atomically in Firestore)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[680px] text-xs">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b]">
                      <th className="py-2 px-2 text-left">PO ID</th>
                      <th className="py-2 px-2 text-left">Product</th>
                      <th className="py-2 px-2 text-right">Qty</th>
                      <th className="py-2 px-2 text-right">Total Value</th>
                      <th className="py-2 px-2 text-left">Order Date</th>
                      <th className="py-2 px-2 text-left">Expected</th>
                      <th className="py-2 px-2 text-left">Status</th>
                      <th className="py-2 px-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {purchaseOrders
                      .slice()
                      .reverse()
                      .slice(0, 8)
                      .map((po) => (
                        <tr key={po.id}>
                          <td className="py-2 px-2 font-mono">
                            {po.id}
                            {renderSampleBadge(po.isSample)}
                          </td>
                          <td className="py-2 px-2">
                            {po.productName || getProductName(po.pid)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {po.qty}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {po.total !== undefined ? fmtCurr(po.total) : '—'}
                          </td>
                          <td className="py-2 px-2 font-mono">{po.od}</td>
                          <td className="py-2 px-2 font-mono">{po.ex}</td>
                          <td className="py-2 px-2">
                            {renderStatusLabel(
                              po.st.toUpperCase(),
                              po.st === 'received'
                                ? 'g'
                                : po.st === 'pending'
                                ? 'o'
                                : 'r'
                            )}
                          </td>
                          <td className="py-2 px-2 text-right space-x-1.5">
                            {po.st === 'pending' && (
                              <>
                                <button
                                  onClick={() => handleUpdatePoStatus(po.id, 'received')}
                                  className="border border-[#262626] hover:bg-[#1f1f1f] text-[#22c55e] rounded px-2 py-0.5 cursor-pointer inline-flex items-center gap-1"
                                >
                                  <CheckCircle2 className="w-3 h-3" /> Mark Received
                                </button>
                                <button
                                  onClick={() => handleUpdatePoStatus(po.id, 'cancelled')}
                                  className="border border-[#262626] hover:bg-[#1f1f1f] text-[#ff5560] rounded px-2 py-0.5 cursor-pointer inline-flex items-center gap-1"
                                >
                                  <XCircle className="w-3 h-3" /> Cancel
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 5: RECOMMENDATIONS & AUTOMATED STAKEHOLDER EXPORTS */}
        {activePage === 'rec' && (
          <section className="space-y-4">
            <div className="bg-[#120a0b] border border-[#262626] rounded-lg p-3 text-xs text-[#d8d8d8]">
              Decision support & automated reporting. Every suggestion shows its mathematical reason so stakeholders can verify it before queuing a purchase order or saving reports to Firestore.
            </div>

            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-2.5 mb-3.5">
                <select
                  value={recFilter}
                  onChange={(e) => setRecFilter(e.target.value)}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                >
                  <option value="all">All recommendations</option>
                  <option value="reorder">Reorder required</option>
                  <option value="stockout">Potential stockout risk</option>
                  <option value="excess">Potential excess stock</option>
                  <option value="ok">In Stock</option>
                </select>

                <button
                  onClick={handleDownloadCsvFile}
                  className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Download CSV & Save Report
                </button>
                <button
                  onClick={() => setCsvModalContent(buildCsvString())}
                  className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-3 py-1.5 text-xs cursor-pointer"
                >
                  Inspect Raw CSV
                </button>
                <button
                  onClick={handleDownloadJsonReport}
                  className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-3 py-1.5 text-xs cursor-pointer"
                >
                  Export Stakeholder JSON & Save Report
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">Product</th>
                      <th className="py-2 px-2 text-right font-semibold">Current Stock</th>
                      <th className="py-2 px-2 text-right font-semibold">Reorder Point</th>
                      <th className="py-2 px-2 text-left font-semibold">Risk Level</th>
                      <th className="py-2 px-2 text-left font-semibold">Reason</th>
                      <th className="py-2 px-2 text-left font-semibold">
                        Suggested Action
                      </th>
                      <th className="py-2 px-2 text-right font-semibold">Quick PO</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {recommendationRows.map((c) => {
                      const suggestedOrderQty = Math.max(
                        10,
                        Math.round(c.rop - c.s + c.p.base * 5)
                      );
                      return (
                        <tr key={c.p.id} className="hover:bg-[#1a1a1a]">
                          <td className="py-2.5 px-2 font-medium">{c.p.name}</td>
                          <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                            {c.s}
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                            {c.rop}
                          </td>
                          <td className="py-2.5 px-2">
                            {renderStatusLabel(c.risk[0], c.risk[1])}
                          </td>
                          <td className="py-2.5 px-2 text-xs text-[#b5b5b5]">{c.why}</td>
                          <td className="py-2.5 px-2 text-xs font-medium">{c.act}</td>
                          <td className="py-2.5 px-2 text-right">
                            {c.f.includes('reorder') ? (
                              <button
                                onClick={() =>
                                  handleCreatePurchaseOrder(c.p.id, suggestedOrderQty)
                                }
                                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-md px-2.5 py-1 text-xs font-mono cursor-pointer"
                              >
                                + Queue PO ({suggestedOrderQty})
                              </button>
                            ) : (
                              <span className="text-xs text-[#9b9b9b]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {recommendationRows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-[#9b9b9b]">
                          No products in this recommendation category.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Saved Stakeholder Reports History (`reports` Collection) */}
            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <h2 className="text-[15px] font-semibold mb-2">
                Saved Stakeholder Reports History (Firestore `reports` Collection)
              </h2>
              {savedReports.length === 0 ? (
                <div className="text-xs text-[#9b9b9b] py-3">
                  No saved reports in Firestore yet. Click "Download CSV & Save Report" or "Export Stakeholder JSON & Save Report" above while signed in.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse min-w-[620px] text-xs">
                    <thead>
                      <tr className="border-b border-[#262626] text-[#9b9b9b]">
                        <th className="py-2 px-2 text-left">Report ID</th>
                        <th className="py-2 px-2 text-left">Type</th>
                        <th className="py-2 px-2 text-left">Date Range</th>
                        <th className="py-2 px-2 text-left">Summary</th>
                        <th className="py-2 px-2 text-left">Generated By</th>
                        <th className="py-2 px-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#262626]">
                      {savedReports.map((r) => (
                        <tr key={r.id} className="hover:bg-[#1a1a1a]">
                          <td className="py-2 px-2 font-mono">{r.id}</td>
                          <td className="py-2 px-2 font-mono text-[#ff5560]">{r.reportType}</td>
                          <td className="py-2 px-2 font-mono text-[#9b9b9b]">{r.dateRange}</td>
                          <td className="py-2 px-2 text-[#f2f2f2]">{r.summary}</td>
                          <td className="py-2 px-2 font-mono text-[#9b9b9b]">{r.generatedBy}</td>
                          <td className="py-2 px-2 text-right">
                            {fbUser && (
                              <button
                                onClick={() => deleteReportFromFirestore(activeTenantId, r.id)}
                                className="text-[#ff5560] hover:underline inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Trash2 className="w-3 h-3" /> Delete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {/* SECTION 6: FIREBASE AUTH, FIRESTORE PERSISTENCE, RBAC & MULTI-TENANT ADMIN */}
        {activePage === 'sec' && (
          <section className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Firebase Auth & RBAC Control Panel */}
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[15px] font-semibold flex items-center gap-2">
                    <Database className="w-4 h-4 text-[#e11d2e]" />
                    Firebase Firestore & RBAC Permissions
                  </h2>
                  {fbUser ? (
                    <button
                      onClick={handleFirebaseSignOut}
                      className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer"
                    >
                      Sign Out ({fbUser.email})
                    </button>
                  ) : (
                    <button
                      onClick={handleFirebaseGoogleSignIn}
                      className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer"
                    >
                      Sign in with Google (Firebase Auth)
                    </button>
                  )}
                </div>

                <p className="text-xs text-[#9b9b9b] mb-3">
                  Project:{' '}
                  <code className="font-mono text-[#f2f2f2] bg-[#0d0d0d] px-1.5 py-0.5 rounded">
                    {firebaseConfig.projectId}
                  </code>{' '}
                  · Database:{' '}
                  <code className="font-mono text-[#f2f2f2] bg-[#0d0d0d] px-1.5 py-0.5 rounded">
                    {firebaseConfig.firestoreDatabaseId}
                  </code>
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-[#262626] text-[#9b9b9b]">
                        <th className="py-2 px-2 text-left">User Account</th>
                        <th className="py-2 px-2 text-left">Auth Provider</th>
                        <th className="py-2 px-2 text-left">Assigned Role</th>
                        <th className="py-2 px-2 text-right">Session Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#262626]">
                      {allUsers.map((u) => (
                        <tr key={u.id} className="hover:bg-[#1a1a1a]">
                          <td className="py-2.5 px-2">
                            <div className="font-medium text-[#f2f2f2]">{u.name}</div>
                            <div className="text-[#9b9b9b] font-mono">{u.email}</div>
                          </td>
                          <td className="py-2.5 px-2 font-mono text-[#b5b5b5]">
                            {u.oauthProvider}
                          </td>
                          <td className="py-2.5 px-2 font-mono font-semibold text-[#ff5560]">
                            {u.role}
                          </td>
                          <td className="py-2.5 px-2 text-right">
                            <button
                              onClick={() => handleSwitchUserOrRole(u.id, u.role)}
                              className={`rounded px-2.5 py-1 text-xs cursor-pointer ${
                                user?.id === u.id
                                  ? 'bg-[#22c55e]/20 text-[#22c55e] font-semibold'
                                  : 'border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2]'
                              }`}
                            >
                              {user?.id === u.id ? 'Active Session' : 'Impersonate / Test'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 pt-3 border-t border-[#262626] text-xs text-[#9b9b9b]">
                  <span className="font-semibold text-[#f2f2f2]">
                    Active Role Capabilities ({user?.role}):
                  </span>{' '}
                  <span className="font-mono">{permissions.join(', ')}</span>
                </div>
              </div>

              {/* Multi-Tenant Scalability Management */}
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold flex items-center gap-2 mb-3">
                  <Building2 className="w-4 h-4 text-[#e11d2e]" />
                  Multi-Tenant Architecture & Isolation
                </h2>

                <div className="space-y-2 mb-4">
                  {tenants.map((t) => (
                    <div
                      key={t.id}
                      className={`flex items-center justify-between p-2.5 rounded-lg border ${
                        t.id === activeTenantId
                          ? 'bg-[#1a1112] border-[#e11d2e]'
                          : 'bg-[#0d0d0d] border-[#262626]'
                      }`}
                    >
                      <div>
                        <div className="text-sm font-semibold text-[#f2f2f2]">
                          {t.name}{' '}
                          <span className="font-mono text-xs text-[#9b9b9b]">
                            ({t.code})
                          </span>
                        </div>
                        <div className="text-xs text-[#9b9b9b]">
                          Region: {t.region} · Currency: {t.currencySymbol} · Created:{' '}
                          {t.createdAt}
                        </div>
                      </div>
                      <button
                        onClick={() => handleTenantChange(t.id)}
                        className={`px-3 py-1 rounded-md text-xs font-semibold cursor-pointer ${
                          t.id === activeTenantId
                            ? 'bg-[#e11d2e] text-white'
                            : 'border border-[#262626] text-[#f2f2f2] hover:bg-[#1f1f1f]'
                        }`}
                      >
                        {t.id === activeTenantId ? 'Current' : 'Switch'}
                      </button>
                    </div>
                  ))}
                </div>

                <div className="border-t border-[#262626] pt-3">
                  <h3 className="text-xs font-semibold text-[#9b9b9b] mb-2">
                    Provision New Tenant Workspace (Requires SUPER_ADMIN)
                  </h3>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <input
                      value={newTenantName}
                      onChange={(e) => setNewTenantName(e.target.value)}
                      placeholder="Organization Name"
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs text-[#f2f2f2]"
                    />
                    <input
                      value={newTenantCode}
                      onChange={(e) => setNewTenantCode(e.target.value)}
                      placeholder="Code (e.g. SG-APAC)"
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs text-[#f2f2f2] font-mono"
                    />
                    <input
                      value={newTenantRegion}
                      onChange={(e) => setNewTenantRegion(e.target.value)}
                      placeholder="Cloud Region"
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs text-[#f2f2f2]"
                    />
                    <select
                      value={newTenantCurrency}
                      onChange={(e) => setNewTenantCurrency(e.target.value)}
                      className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs text-[#f2f2f2]"
                    >
                      <option value="₹">₹ INR</option>
                      <option value="$">$ USD</option>
                      <option value="€">€ EUR</option>
                    </select>
                  </div>
                  <button
                    onClick={handleProvisionTenant}
                    className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3.5 py-1.5 text-xs cursor-pointer"
                  >
                    + Provision Isolated Tenant
                  </button>
                </div>
              </div>
            </div>

            {/* Real-Time Security Audit Log */}
            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 className="text-[15px] font-semibold flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#e11d2e]" />
                  Real-Time Security & Administrative Audit Log
                </h2>
                <div className="flex items-center gap-2">
                  <input
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    placeholder="Filter by actor, event, or SKU"
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1 text-xs text-[#f2f2f2]"
                  />
                  <select
                    value={auditSeverityFilter}
                    onChange={(e) => setAuditSeverityFilter(e.target.value)}
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1 text-xs text-[#f2f2f2]"
                  >
                    <option value="all">All Severities</option>
                    <option value="INFO">INFO</option>
                    <option value="WARN">WARN</option>
                    <option value="CRITICAL">CRITICAL</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[680px] text-xs">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b]">
                      <th className="py-2 px-2 text-left">Seq</th>
                      <th className="py-2 px-2 text-left">Date</th>
                      <th className="py-2 px-2 text-left">Severity</th>
                      <th className="py-2 px-2 text-left">Category</th>
                      <th className="py-2 px-2 text-left">Action Description</th>
                      <th className="py-2 px-2 text-left">Actor Identity</th>
                      <th className="py-2 px-2 text-left">RBAC Role</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {auditLogs
                      .filter((a) => {
                        const q = auditSearch.toLowerCase();
                        const matchQ =
                          !q ||
                          a.m.toLowerCase().includes(q) ||
                          a.k.toLowerCase().includes(q) ||
                          a.actorEmail.toLowerCase().includes(q);
                        const matchSev =
                          auditSeverityFilter === 'all' ||
                          a.severity === auditSeverityFilter;
                        return matchQ && matchSev;
                      })
                      .slice()
                      .sort((a, b) => b.n - a.n)
                      .map((a) => (
                        <tr key={a.id} className="hover:bg-[#1a1a1a]">
                          <td className="py-2 px-2 font-mono text-[#9b9b9b] tabular-nums">
                            #{a.n}
                          </td>
                          <td className="py-2 px-2 font-mono tabular-nums">{a.d}</td>
                          <td className="py-2 px-2">
                            {renderStatusLabel(
                              a.severity,
                              a.severity === 'CRITICAL'
                                ? 'r'
                                : a.severity === 'WARN'
                                ? 'o'
                                : 'g'
                            )}
                          </td>
                          <td className="py-2 px-2 font-semibold">{a.k}</td>
                          <td className="py-2 px-2 text-[#f2f2f2]">{a.m}</td>
                          <td className="py-2 px-2 font-mono text-[#b5b5b5]">
                            {a.actorEmail}
                          </td>
                          <td className="py-2 px-2 font-mono text-[#9b9b9b]">
                            {a.actorRole}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Product View Modal */}
      {viewingProduct && (
        <div
          onClick={() => setViewingProduct(null)}
          className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-30"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#141414] border border-[#262626] rounded-xl p-5 w-[480px] max-w-full"
          >
            {(() => {
              const c = calculateProductAnalytics(
                viewingProduct,
                transactions,
                purchaseOrders,
                demandMap,
                todayStr,
                30,
                60
              );
              const st = getStockStatus(viewingProduct, transactions);
              const supName =
                suppliers.find((s) => s.id === viewingProduct.sup)?.name || 'Unknown';
              const pCost = viewingProduct.purchaseCost ?? viewingProduct.cost;
              const sPrice =
                viewingProduct.sellingPrice ?? Math.round(pCost * 1.25);
              return (
                <>
                  <h2 className="text-base font-semibold mb-2">
                    {viewingProduct.productName || viewingProduct.name}{' '}
                    <span className="text-[#9b9b9b] font-mono">
                      ({viewingProduct.sku} · ID:{viewingProduct.productId || viewingProduct.id})
                    </span>
                    {renderSampleBadge(viewingProduct.isSample)}
                  </h2>
                  <p className="text-sm text-[#d4d4d4] leading-relaxed mb-3">
                    Category: {viewingProduct.category || 'General Electronics'} · Warehouse:{' '}
                    {getWarehouseForProduct(viewingProduct.id)}
                    <br />
                    Supplier: {supName}
                    <br />
                    Purchase Cost: {fmtCurr(pCost)} · Selling Price: {fmtCurr(sPrice)}
                    <br />
                    Current Stock: {c.s} {viewingProduct.unit || 'units'} · Low-Stock Threshold:{' '}
                    {viewingProduct.lowStockThreshold ?? viewingProduct.rop} units · Status:{' '}
                    {renderStatusLabel(st[0], st[1])}
                    <br />
                    Purchase Value: {fmtCurr(c.s * pCost)} · Potential Selling Value:{' '}
                    {fmtCurr(c.s * sPrice)}
                    <br />
                    Lead time {viewingProduct.lead} days · Safety stock{' '}
                    {viewingProduct.safety} {viewingProduct.unit || 'units'} · Avg demand (30 d){' '}
                    {c.a.toFixed(1)} units/day
                  </p>
                  {viewingProduct.description && (
                    <p className="text-xs text-[#9b9b9b] mb-3">
                      {viewingProduct.description}
                    </p>
                  )}
                  <p className="text-sm mb-4">
                    {renderStatusLabel(c.risk[0], c.risk[1])} — {c.why}
                  </p>
                  <button
                    onClick={() => setViewingProduct(null)}
                    className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-4 py-1.5 text-sm cursor-pointer"
                  >
                    Close
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Product Add/Edit Modal */}
      {editingProduct && (
        <div
          onClick={() => setEditingProduct(null)}
          className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-30"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#141414] border border-[#262626] rounded-xl p-5 w-[560px] max-w-full max-h-[90vh] overflow-auto"
          >
            <h2 className="text-base font-semibold mb-3">
              {editingProduct.id ? 'Edit' : 'Add'} Product (Saves to Firestore `products` & `inventory`)
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Product ID (`productId` / Document ID) *
                </label>
                <input
                  value={editingProduct.productId}
                  disabled={editingProduct.id > 0}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      productId: e.target.value.toUpperCase(),
                    })
                  }
                  placeholder="e.g. PROD011"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">SKU</label>
                <input
                  value={editingProduct.sku}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, sku: e.target.value })
                  }
                  placeholder="e.g. LAP-002"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Product Name *
                </label>
                <input
                  value={editingProduct.name}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, name: e.target.value })
                  }
                  placeholder="e.g. Workstation Laptop"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Category *</label>
                <input
                  list="product-categories-list"
                  value={editingProduct.category}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, category: e.target.value })
                  }
                  placeholder="Select or type category"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
                <datalist id="product-categories-list">
                  {availableCategories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Warehouse Location (`inventory`)
                </label>
                <input
                  value={editingProduct.warehouseLocation}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      warehouseLocation: e.target.value,
                    })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Purchase Cost ({currencySymbol}) *
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingProduct.cost}
                  onChange={(e) => {
                    const nextCost = e.target.value;
                    const autoSell =
                      editingProduct.sellingPrice === '' && nextCost !== '' && !isNaN(+nextCost)
                        ? String(Math.round(+nextCost * 1.25))
                        : editingProduct.sellingPrice;
                    setEditingProduct({
                      ...editingProduct,
                      cost: nextCost,
                      sellingPrice: autoSell,
                    });
                  }}
                  placeholder="e.g. 12000"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Selling Price ({currencySymbol}) *
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingProduct.sellingPrice}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      sellingPrice: e.target.value,
                    })
                  }
                  placeholder="e.g. 15500"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Current Stock (units) *
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={editingProduct.stock}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, stock: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Low-Stock Threshold / ROP (units) *
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={editingProduct.rop}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, rop: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Lead time (days)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingProduct.lead}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, lead: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Safety stock (units)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingProduct.safe}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, safe: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Supplier</label>
                <select
                  value={editingProduct.sup}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      sup: Number(e.target.value),
                    })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                >
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Unit</label>
                <input
                  value={editingProduct.unit}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, unit: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#9b9b9b] mb-1">Description</label>
                <input
                  value={editingProduct.description}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      description: e.target.value,
                    })
                  }
                  placeholder="Product specification or SKU notes"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
            </div>

            {/* Live Automatic Stock Status Preview */}
            {(() => {
              const sVal = Math.max(0, Number(editingProduct.stock) || 0);
              const tVal = Math.max(0, Number(editingProduct.rop) || 0);
              const autoLabel = computeStockStatusLabel(sVal, tVal);
              const color =
                autoLabel === 'Out of Stock' ? 'r' : autoLabel === 'Low Stock' ? 'o' : 'g';
              return (
                <div className="mt-3 bg-[#0d0d0d] border border-[#262626] rounded-lg p-2.5 text-xs flex items-center justify-between">
                  <span className="text-[#9b9b9b]">
                    Automatically Calculated <code className="font-mono">stockStatus</code> (enforced by Firestore rules):
                  </span>
                  {renderStatusLabel(autoLabel, color)}
                </div>
              );
            })()}

            {editingProduct.errors.length > 0 && (
              <div className="text-xs text-[#ff5560] my-2.5 space-y-1">
                {editingProduct.errors.map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={handleSaveProduct}
                className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                Save to Firestore
              </button>
              <button
                onClick={() => setEditingProduct(null)}
                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Supplier Add/Edit Modal */}
      {editingSupplier && (
        <div
          onClick={() => setEditingSupplier(null)}
          className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-30"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#141414] border border-[#262626] rounded-xl p-5 w-[480px] max-w-full"
          >
            <h2 className="text-base font-semibold mb-3">
              {editingSupplier.id ? 'Edit' : 'Add'} Supplier (Firestore `suppliers`)
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#9b9b9b] mb-1">Supplier Name</label>
                <input
                  value={editingSupplier.name}
                  onChange={(e) =>
                    setEditingSupplier({ ...editingSupplier, name: e.target.value })
                  }
                  placeholder="e.g. Global Chipset Logistics"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Contact Person</label>
                <input
                  value={editingSupplier.contactPerson}
                  onChange={(e) =>
                    setEditingSupplier({
                      ...editingSupplier,
                      contactPerson: e.target.value,
                    })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Status</label>
                <select
                  value={editingSupplier.status}
                  onChange={(e) =>
                    setEditingSupplier({
                      ...editingSupplier,
                      status: e.target.value as 'ACTIVE' | 'ON_HOLD' | 'INACTIVE',
                    })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="ON_HOLD">ON_HOLD</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Email</label>
                <input
                  value={editingSupplier.email}
                  onChange={(e) =>
                    setEditingSupplier({ ...editingSupplier, email: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Phone</label>
                <input
                  value={editingSupplier.phone}
                  onChange={(e) =>
                    setEditingSupplier({ ...editingSupplier, phone: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#9b9b9b] mb-1">Address</label>
                <input
                  value={editingSupplier.address}
                  onChange={(e) =>
                    setEditingSupplier({ ...editingSupplier, address: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={handleSaveSupplier}
                className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                Save Supplier
              </button>
              <button
                onClick={() => setEditingSupplier(null)}
                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingProduct && (
        <div
          onClick={() => setDeletingProduct(null)}
          className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-30"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#141414] border border-[#262626] rounded-xl p-5 w-[440px] max-w-full"
          >
            <h2 className="text-base font-semibold mb-2">Delete product from Firestore?</h2>
            <p className="text-sm text-[#b5b5b5] mb-4">
              This removes <b className="text-[#f2f2f2]">{deletingProduct.name}</b>, its
              inventory balance record, forecast, and stock transactions. This cannot be undone.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleDeleteProduct(deletingProduct.id)}
                className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setDeletingProduct(null)}
                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-4 py-1.5 text-sm cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Raw CSV Modal */}
      {csvModalContent !== null && (
        <div
          onClick={() => setCsvModalContent(null)}
          className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-30"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#141414] border border-[#262626] rounded-xl p-5 w-[520px] max-w-full"
          >
            <h2 className="text-base font-semibold mb-1">CSV Export Preview</h2>
            <p className="text-xs text-[#9b9b9b] mb-3">
              Copy the text below or click Download CSV File for direct stakeholder export.
            </p>
            <textarea
              readOnly
              rows={9}
              value={csvModalContent}
              onFocus={(e) => e.target.select()}
              className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg p-2.5 text-xs font-mono text-[#f2f2f2] mb-3"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleDownloadCsvFile}
                className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-4 py-1.5 text-xs cursor-pointer"
              >
                Download .CSV File
              </button>
              <button
                onClick={() => setCsvModalContent(null)}
                className="border border-[#262626] hover:bg-[#1f1f1f] text-[#f2f2f2] rounded-lg px-4 py-1.5 text-xs cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification Stack */}
      <div className="fixed right-4 bottom-4 z-40 grid gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-3.5 py-2.5 rounded-lg bg-[#161616] border text-sm shadow-xl ${
              t.isError
                ? 'border-[#ff5560] text-[#ff5560]'
                : 'border-[#22c55e] text-[#f2f2f2]'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import {
  Tenant,
  UserProfile,
  UserRole,
  TenantDataState,
  Product,
  PresenceClient,
} from './types';
import {
  sum,
  formatDate,
  addDays,
  formatCurrency,
  getStock,
  getStockStatus,
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
  KeyRound,
  Plus,
  Search,
  CheckCircle2,
  XCircle,
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

interface ToastMsg {
  id: number;
  message: string;
  isError?: boolean;
}

export default function App() {
  const [activePage, setActivePage] = useState<PageKey>('dash');
  const [barLoading, setBarLoading] = useState(false);

  // Auth, RBAC & Multi-Tenant state
  const [token, setToken] = useState<string>('oauth2_ent_tok_akhilesh_superadmin_2026');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string>('tenant-in-01');
  const [tenantState, setTenantState] = useState<TenantDataState | null>(null);
  const [presence, setPresence] = useState<PresenceClient[]>([]);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [appUrl, setAppUrl] = useState<string>('');

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

  // Products page filters & pagination
  const [prodQuery, setProdQuery] = useState('');
  const [prodStatusFilter, setProdStatusFilter] = useState<'all' | 'ok' | 'low' | 'out'>('all');
  const [prodSort, setProdSort] = useState<'name' | 'qty' | 'val'>('name');
  const [prodPage, setProdPage] = useState(1);

  // Product Modals
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [editingProduct, setEditingProduct] = useState<{
    id: number;
    sku: string;
    name: string;
    cost: string;
    lead: string;
    rop: string;
    stock: string;
    safe: string;
    sup: number;
    errors: string[];
  } | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<Product | null>(null);

  // Inventory form & filter state
  const [txPid, setTxPid] = useState<number>(1);
  const [txType, setTxType] = useState<'IN' | 'OUT' | 'ADJUST'>('IN');
  const [txQty, setTxQty] = useState<string>('');
  const [txDate, setTxDate] = useState<string>('2026-10-27');
  const [txNote, setTxNote] = useState<string>('');
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
        if (!res.ok) throw new Error('Failed to load workspace state');
        const data = await res.json();
        setUser(data.user);
        setAllUsers(data.users || []);
        setPermissions(data.permissions || []);
        setTenants(data.tenants || []);
        setActiveTenantId(data.activeTenantId);
        setTenantState(data.state);
        setAppUrl(data.appUrl || window.location.origin);
        if (data.state?.today) {
          setTxDate(data.state.today);
        }
        if (data.state?.products?.length > 0) {
          setTxPid((prev) =>
            data.state.products.some((p: Product) => p.id === prev)
              ? prev
              : data.state.products[0].id
          );
          setAnaForecastPid((prev) =>
            data.state.products.some((p: Product) => p.id === prev)
              ? prev
              : data.state.products[0].id
          );
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
              userName: user.name,
              userEmail: user.email,
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
          if (msg.type === 'state:sync' && msg.tenantId === activeTenantId) {
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
  }, [activeTenantId, user?.email, user?.role]);

  // Listen for OAuth2 popup postMessage completion
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const newTok = event.data.token;
        if (newTok) {
          setToken(newTok);
          fetchBootstrap(activeTenantId, newTok);
        } else {
          fetchBootstrap(activeTenantId);
        }
        showToast('OAuth2 PKCE handshake verified & token active');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeTenantId, fetchBootstrap, showToast]);

  const navigateTo = (page: PageKey) => {
    setBarLoading(true);
    setActivePage(page);
    setTimeout(() => setBarLoading(false), 350);
  };

  const handleTenantChange = (newTenantId: string) => {
    setBarLoading(true);
    setActiveTenantId(newTenantId);
    fetchBootstrap(newTenantId).finally(() => {
      setTimeout(() => setBarLoading(false), 350);
    });
    if (wsRef.current?.readyState === WebSocket.OPEN && user) {
      wsRef.current.send(
        JSON.stringify({
          type: 'client:identify',
          userName: user.name,
          userEmail: user.email,
          role: user.role,
          tenantId: newTenantId,
        })
      );
    }
    showToast(`Switched tenant workspace to ${newTenantId}`);
  };

  const handleOAuthPopupLogin = async (provider = 'google-oauth2') => {
    try {
      const res = await fetch(`/api/auth/url?provider=${encodeURIComponent(provider)}`);
      if (!res.ok) throw new Error('Failed to construct OAuth2 URL');
      const { url } = await res.json();
      const popup = window.open(url, 'oauth2_popup', 'width=560,height=640');
      if (!popup) {
        showToast('Popup blocked by browser. Please allow popups for OAuth2 sign-in.', true);
      }
    } catch {
      showToast('Failed to initiate OAuth2 flow', true);
    }
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

  const fmtCurr = useCallback(
    (n: number) => formatCurrency(n, currencySymbol, currencyLocale),
    [currencySymbol, currencyLocale]
  );

  // Dashboard calculations (30d window, 60d excess threshold)
  const dashAnalytics = useMemo(
    () =>
      products.map((p) =>
        calculateProductAnalytics(p, transactions, purchaseOrders, demandMap, todayStr, 30, 60)
      ),
    [products, transactions, purchaseOrders, demandMap, todayStr]
  );

  const totalInventoryValue = useMemo(
    () => sum(products.map((p) => getStock(p, transactions) * p.cost)),
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

  // Filtered & sorted products
  const filteredProducts = useMemo(() => {
    const q = prodQuery.toLowerCase();
    const rows = products.filter((p) => {
      const matchesQ =
        !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
      const stCode = getStockStatus(p, transactions)[2];
      const matchesF = prodStatusFilter === 'all' || stCode === prodStatusFilter;
      return matchesQ && matchesF;
    });
    rows.sort((a, b) => {
      if (prodSort === 'name') return a.name.localeCompare(b.name);
      if (prodSort === 'qty') return getStock(b, transactions) - getStock(a, transactions);
      return getStock(b, transactions) * b.cost - getStock(a, transactions) * a.cost;
    });
    return rows;
  }, [products, transactions, prodQuery, prodStatusFilter, prodSort]);

  const prodTotalPages = Math.max(1, Math.ceil(filteredProducts.length / 6));
  const safeProdPage = Math.min(prodTotalPages, Math.max(1, prodPage));

  // Product CRUD handlers
  const openProductModal = (prod?: Product) => {
    if (prod) {
      setEditingProduct({
        id: prod.id,
        sku: prod.sku,
        name: prod.name,
        cost: String(prod.cost),
        lead: String(prod.lead),
        rop: String(prod.rop),
        stock: String(getStock(prod, transactions)),
        safe: String(prod.safety),
        sup: prod.sup,
        errors: [],
      });
    } else {
      setEditingProduct({
        id: 0,
        sku: '',
        name: '',
        cost: '',
        lead: '',
        rop: '',
        stock: '',
        safe: '',
        sup: suppliers[0]?.id || 1,
        errors: [],
      });
    }
  };

  const handleSaveProduct = async () => {
    if (!editingProduct) return;
    const isEdit = editingProduct.id > 0;
    const url = isEdit ? `/api/products/${editingProduct.id}` : '/api/products';
    const method = isEdit ? 'PUT' : 'POST';

    try {
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
        if (data.errors) {
          setEditingProduct((prev) => (prev ? { ...prev, errors: data.errors } : null));
          showToast('Please fix the highlighted errors', true);
        } else {
          showToast(data.error || 'Failed to save product', true);
        }
        return;
      }
      setTenantState(data.state);
      setEditingProduct(null);
      showToast('Product saved');
    } catch {
      showToast('Network error saving product', true);
    }
  };

  const handleDeleteProduct = async (id: number) => {
    try {
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
      showToast('Product deleted');
    } catch {
      showToast('Network error deleting product', true);
    }
  };

  // Inventory Ledger warning & transaction saving
  const txWarning = useMemo(() => {
    const p = products.find((x) => x.id === Number(txPid));
    const q = Number(txQty);
    if (!p || !q) return '';
    const d = txType === 'IN' ? q : txType === 'OUT' ? -q : q;
    const avail = getStock(p, transactions);
    if (avail + d < 0) {
      return `Warning: this would make stock negative. Available: ${avail} units. It will be rejected.`;
    }
    return '';
  }, [products, transactions, txPid, txQty, txType]);

  const handleSaveTransaction = async () => {
    try {
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
          date: txDate || todayStr,
          note: txNote,
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
      showToast(`Transaction saved. New stock: ${data.newStock}`);
    } catch {
      showToast('Failed to save transaction', true);
    }
  };

  const getProductName = useCallback(
    (pid: number) => {
      const p = products.find((x) => x.id === pid);
      return p ? p.name : '(deleted)';
    },
    [products]
  );

  const filteredTransactions = useMemo(() => {
    const q = invSearch.toLowerCase();
    return transactions
      .filter((t) => {
        const matchProd = invProdFilter === 'all' || t.pid === Number(invProdFilter);
        const matchFrom = !invFromDate || t.date >= invFromDate;
        const matchTo = !invToDate || t.date <= invToDate;
        const pName = getProductName(t.pid).toLowerCase();
        const matchQ = !q || t.note.toLowerCase().includes(q) || pName.includes(q);
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
    };
  }, [products, demandMap, dates, todayStr, anaForecastPid, anaWindow]);

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

  const handleDownloadCsvFile = () => {
    const csvText = buildCsvString();
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `supply_chain_recommendations_${activeTenantId}_${todayStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Downloaded stakeholder CSV report');
  };

  const handleDownloadJsonReport = () => {
    const reportPayload = {
      generatedAt: new Date().toISOString(),
      tenant: tenantState?.tenant,
      generatedBy: user?.email,
      kpis: {
        totalProducts: products.length,
        totalSuppliers: suppliers.length,
        inventoryValue: totalInventoryValue,
        belowReorderPoint: lowStockCount + outOfStockCount,
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
    showToast('Generated stakeholder JSON audit report');
  };

  const handleCreatePurchaseOrder = async (pid: number, suggestedQty: number) => {
    try {
      const res = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-tenant-id': activeTenantId,
        },
        body: JSON.stringify({ pid, qty: suggestedQty }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not create PO', true);
        return;
      }
      setTenantState(data.state);
      showToast(`Created ${data.purchaseOrder.id} (${suggestedQty} units)`);
    } catch {
      showToast('Failed to create purchase order', true);
    }
  };

  const handleUpdatePoStatus = async (poId: string, status: 'received' | 'cancelled') => {
    try {
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
      setActiveTenantId(data.tenant.id);
      setTenantState(data.state);
      setNewTenantName('');
      setNewTenantCode('');
      showToast(`Provisioned tenant ${data.tenant.name}`);
    } catch {
      showToast('Failed to provision tenant', true);
    }
  };

  const renderStatusLabel = (text: string, colorCode: 'r' | 'o' | 'g' | 'b') => {
    const colorClasses = {
      g: 'text-[#22c55e]',
      o: 'text-[#f59e0b]',
      r: 'text-[#ff5560]',
      b: 'text-[#d4d4d4]',
    }[colorCode];
    return <span className={`font-semibold text-xs ${colorClasses}`}>{text}</span>;
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

        {/* Bottom RBAC Identity Switcher & Live Sync Indicator */}
        <div className="hidden lg:flex flex-col gap-2.5 mt-auto pt-4 border-t border-[#262626] px-1 text-xs">
          <div className="flex items-center justify-between text-[#9b9b9b]">
            <span>Real-time WS Stream</span>
            <span className="font-mono text-[11px] text-[#f2f2f2]">
              {wsConnected ? `Connected (${presence.length})` : 'Reconnecting'}
            </span>
          </div>
          {user && (
            <div className="bg-[#0d0d0d] border border-[#262626] rounded-lg p-2.5">
              <div className="font-semibold text-[#f2f2f2] truncate">{user.name}</div>
              <div className="text-[11px] text-[#9b9b9b] truncate mb-2">
                {user.email} · <span className="text-[#ff5560] font-mono">{user.role}</span>
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
        </div>
      </aside>

      {/* Main Content Viewport */}
      <main className="p-5 lg:p-6 min-w-0 max-w-[1600px]">
        {/* Top Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 mb-4 pb-3 border-b border-[#262626]">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">
              {PAGES.find((p) => p[0] === activePage)?.[1]}
            </h1>
            <span className="text-xs text-[#9b9b9b] hidden sm:inline">
              · {tenantState?.tenant.name} ({tenantState?.tenant.region}) · Role:{' '}
              <strong className="text-[#f2f2f2] font-mono">{user?.role}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Mobile Tenant Selector */}
            <select
              value={activeTenantId}
              onChange={(e) => handleTenantChange(e.target.value)}
              className="lg:hidden bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs text-[#f2f2f2]"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code}
                </option>
              ))}
            </select>

            <button
              onClick={handleDownloadCsvFile}
              className="bg-[#141414] hover:bg-[#1f1f1f] text-[#f2f2f2] border border-[#262626] rounded-lg px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-[#e11d2e]" />
              Export CSV Report
            </button>
          </div>
        </header>

        {/* Top Progress Transition Bar */}
        <div
          className="h-[3px] bg-[#e11d2e] rounded-xs mb-4 transition-all duration-300"
          style={{ width: barLoading ? '100%' : '0%' }}
        />

        {/* SECTION 1: DASHBOARD */}
        {activePage === 'dash' && (
          <section className="space-y-4">
            {/* 6 KPI Grid */}
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
                {
                  label: 'Potential Stockout Risks',
                  val: dashAnalytics.filter((c) => c.f.includes('stockout')).length,
                  alert: true,
                },
                {
                  label: 'Potential Excess Risks',
                  val: dashAnalytics.filter((c) => c.f === 'excess').length,
                  alert: false,
                },
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
                      sum(products.map((p) => getStock(p, transactions))).toLocaleString(
                        currencyLocale
                      ),
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
                <h2 className="text-[15px] font-semibold mb-2">
                  Inventory Distribution (D3.js)
                </h2>
                <D3InventoryDonut counts={donutCounts} />
              </div>

              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold mb-2.5">
                  Demand Analysis (D3.js Time-Series)
                </h2>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <select
                    value={demProductFilter}
                    onChange={(e) => setDemProductFilter(e.target.value)}
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                  >
                    <option value="all">All products</option>
                    {products.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={demMode}
                    onChange={(e) => setDemMode(e.target.value as 'd' | 'm')}
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                  >
                    <option value="d">Daily (90 days)</option>
                    <option value="m">Monthly</option>
                  </select>
                </div>
                <D3DemandChart
                  labels={demandChartData.labels}
                  values={demandChartData.values}
                  mode={demMode}
                />
                <div className="text-xs text-[#9b9b9b] mt-1">
                  Monthly view: first and last months are partial. Hover chart to inspect exact daily or monthly demand.
                </div>
              </div>
            </div>

            {/* Row 3: Supplier Performance & Recent Real-Time Activities */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <h2 className="text-[15px] font-semibold mb-2.5">
                  Supplier Performance (D3.js)
                </h2>
                <div className="grid grid-cols-3 gap-2.5 mb-3">
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
                            <td className="py-2.5 px-2 font-medium">{p.name}</td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {getStock(p, transactions)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {p.rop}
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
                        <td colSpan={5} className="py-4 text-center text-[#9b9b9b]">
                          No low-stock alerts. All SKUs are above their reorder point.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 2: PRODUCTS */}
        {activePage === 'prod' && (
          <section className="space-y-4">
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
                    placeholder="Search name or SKU"
                    className="bg-[#0d0d0d] border border-[#262626] rounded-lg pl-9 pr-3 py-1.5 text-sm text-[#f2f2f2] focus:outline-2 focus:outline-[#7f1d1d]"
                  />
                </div>
                <select
                  value={prodStatusFilter}
                  onChange={(e) => {
                    setProdStatusFilter(e.target.value as 'all' | 'ok' | 'low' | 'out');
                    setProdPage(1);
                  }}
                  className="bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                >
                  <option value="all">All statuses</option>
                  <option value="ok">Healthy</option>
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

                <button
                  onClick={() => openProductModal()}
                  className="ml-auto bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3.5 py-1.5 text-sm flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Plus className="w-4 h-4" /> Add Product
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">ID</th>
                      <th className="py-2 px-2 text-left font-semibold">SKU</th>
                      <th className="py-2 px-2 text-left font-semibold">Product Name</th>
                      <th className="py-2 px-2 text-right font-semibold">Unit Cost</th>
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
                        return (
                          <tr key={p.id} className="hover:bg-[#1a1a1a]">
                            <td className="py-2.5 px-2 font-mono text-xs text-[#9b9b9b] tabular-nums">
                              {p.id}
                            </td>
                            <td className="py-2.5 px-2 font-mono text-xs tabular-nums">
                              {p.sku}
                            </td>
                            <td className="py-2.5 px-2 font-medium">{p.name}</td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {fmtCurr(p.cost)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {getStock(p, transactions)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                              {p.rop}
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
                        <td colSpan={8} className="py-6 text-center text-[#9b9b9b]">
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
          </section>
        )}

        {/* SECTION 3: INVENTORY LEDGER */}
        {activePage === 'inv' && (
          <section className="space-y-4">
            <div className="bg-[#120a0b] border border-[#262626] rounded-lg p-3 text-xs text-[#d8d8d8]">
              Ledger Invariant: Current Stock = Opening Stock + IN − OUT + adjustments. OUT is stored as a negative quantity and each adjustment as one signed quantity, so nothing is counted twice. Stock is derived from the ledger, so the balance and the transaction can never disagree.
            </div>

            <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
              <h2 className="text-[15px] font-semibold mb-3">Record Transaction</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">Product</label>
                  <select
                    value={txPid}
                    onChange={(e) => setTxPid(Number(e.target.value))}
                    className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} (Stock: {getStock(p, transactions)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#9b9b9b] mb-1">Type</label>
                  <select
                    value={txType}
                    onChange={(e) =>
                      setTxType(e.target.value as 'IN' | 'OUT' | 'ADJUST')
                    }
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
              </div>
              <div className="mt-3">
                <label className="block text-xs text-[#9b9b9b] mb-1">Notes</label>
                <input
                  value={txNote}
                  onChange={(e) => setTxNote(e.target.value)}
                  maxLength={120}
                  placeholder="Optional reference number, cycle count reason, or PO code"
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 text-sm text-[#f2f2f2]"
                />
              </div>
              {txWarning && (
                <div className="text-xs text-[#ff5560] mt-2 font-medium">{txWarning}</div>
              )}
              <button
                onClick={handleSaveTransaction}
                className="mt-3 bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-4 py-2 text-sm cursor-pointer"
              >
                Save Transaction
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
                      {p.name}
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
                    sum(
                      filteredTransactions
                        .filter((t) => t.type === 'IN')
                        .map((t) => t.qty)
                    ),
                  ],
                  [
                    'Total OUT',
                    sum(
                      filteredTransactions
                        .filter((t) => t.type === 'OUT')
                        .map((t) => t.qty)
                    ),
                  ],
                  [
                    'Net adjustments',
                    sum(
                      filteredTransactions
                        .filter((t) => t.type === 'ADJUST')
                        .map((t) => t.qty)
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
                <table className="w-full border-collapse min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b] text-xs">
                      <th className="py-2 px-2 text-left font-semibold">ID</th>
                      <th className="py-2 px-2 text-left font-semibold">Product</th>
                      <th className="py-2 px-2 text-left font-semibold">Date</th>
                      <th className="py-2 px-2 text-left font-semibold">Type</th>
                      <th className="py-2 px-2 text-right font-semibold">Qty</th>
                      <th className="py-2 px-2 text-left font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#262626]">
                    {filteredTransactions
                      .slice((safeInvPage - 1) * 8, safeInvPage * 8)
                      .map((t) => (
                        <tr key={t.id} className="hover:bg-[#1a1a1a]">
                          <td className="py-2.5 px-2 font-mono text-xs text-[#9b9b9b] tabular-nums">
                            {t.id}
                          </td>
                          <td className="py-2.5 px-2 font-medium">
                            {getProductName(t.pid)}
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
                          <td className="py-2.5 px-2 text-[#b5b5b5]">{t.note}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-end gap-2.5 mt-3 text-xs">
                <span className="text-[#9b9b9b] font-mono tabular-nums">
                  {filteredTransactions.length} records · page {safeInvPage} of{' '}
                  {invTotalPages}
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
                  <h2 className="text-[15px] font-semibold">
                    Demand Forecast (D3.js Baseline Evaluation)
                  </h2>
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
                Supplier Delivery Performance & Active Purchase Orders
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
                Purchase Order Queue (Receive pending POs to credit stock ledger live)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[620px] text-xs">
                  <thead>
                    <tr className="border-b border-[#262626] text-[#9b9b9b]">
                      <th className="py-2 px-2 text-left">PO ID</th>
                      <th className="py-2 px-2 text-left">Product</th>
                      <th className="py-2 px-2 text-right">Qty</th>
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
                          <td className="py-2 px-2 font-mono">{po.id}</td>
                          <td className="py-2 px-2">{getProductName(po.pid)}</td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {po.qty}
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
              Decision support & automated reporting. Every suggestion shows its mathematical reason so stakeholders can verify it before queuing a purchase order or exporting reports.
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
                  <option value="ok">Healthy stock</option>
                </select>

                <button
                  onClick={handleDownloadCsvFile}
                  className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Download CSV File
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
                  Export Stakeholder JSON
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
          </section>
        )}

        {/* SECTION 6: SECURITY, OAUTH2, RBAC & MULTI-TENANT ADMINISTRATION */}
        {activePage === 'sec' && (
          <section className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* OAuth2 & RBAC Control Panel */}
              <div className="bg-[#141414] border border-[#262626] rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[15px] font-semibold flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-[#e11d2e]" />
                    OAuth2 Authentication & RBAC Permissions
                  </h2>
                  <button
                    onClick={() => handleOAuthPopupLogin('google-oauth2')}
                    className="bg-[#e11d2e] hover:bg-[#c3101f] text-white font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer"
                  >
                    Re-Authenticate via OAuth2 Popup
                  </button>
                </div>

                <p className="text-xs text-[#9b9b9b] mb-3">
                  Active OAuth2 Callback Endpoint:{' '}
                  <code className="font-mono text-[#f2f2f2] bg-[#0d0d0d] px-1.5 py-0.5 rounded">
                    {appUrl}/auth/callback
                  </code>
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-[#262626] text-[#9b9b9b]">
                        <th className="py-2 px-2 text-left">User Account</th>
                        <th className="py-2 px-2 text-left">OAuth2 Provider</th>
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
                      <th className="py-2 px-2 text-left">Actor (OAuth2 Identity)</th>
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
              const supName =
                suppliers.find((s) => s.id === viewingProduct.sup)?.name || 'Unknown';
              return (
                <>
                  <h2 className="text-base font-semibold mb-2">
                    {viewingProduct.name}{' '}
                    <span className="text-[#9b9b9b] font-mono">{viewingProduct.sku}</span>
                  </h2>
                  <p className="text-sm text-[#d4d4d4] leading-relaxed mb-3">
                    Supplier: {supName}
                    <br />
                    Unit cost {fmtCurr(viewingProduct.cost)} · Lead time{' '}
                    {viewingProduct.lead} days · Safety stock {viewingProduct.safety} units
                    <br />
                    Stock {c.s} units · Inventory value {fmtCurr(c.s * viewingProduct.cost)}
                    <br />
                    Avg demand (30 d) {c.a.toFixed(1)} units/day · Calculated ROP {c.rop}{' '}
                    units
                  </p>
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
            className="bg-[#141414] border border-[#262626] rounded-xl p-5 w-[480px] max-w-full max-h-[90vh] overflow-auto"
          >
            <h2 className="text-base font-semibold mb-3">
              {editingProduct.id ? 'Edit' : 'Add'} Product
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">SKU</label>
                <input
                  value={editingProduct.sku}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, sku: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">Product name</label>
                <input
                  value={editingProduct.name}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, name: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Unit cost ({currencySymbol} per unit)
                </label>
                <input
                  type="number"
                  value={editingProduct.cost}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, cost: e.target.value })
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
                  value={editingProduct.lead}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, lead: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Reorder point (units)
                </label>
                <input
                  type="number"
                  value={editingProduct.rop}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, rop: e.target.value })
                  }
                  className="w-full bg-[#0d0d0d] border border-[#262626] rounded-lg px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[#9b9b9b] mb-1">
                  Current stock (units)
                </label>
                <input
                  type="number"
                  value={editingProduct.stock}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, stock: e.target.value })
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
            </div>

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
                Save
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
            <h2 className="text-base font-semibold mb-2">Delete product?</h2>
            <p className="text-sm text-[#b5b5b5] mb-4">
              This removes <b className="text-[#f2f2f2]">{deletingProduct.name}</b> and its
              stock transactions. This cannot be undone.
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

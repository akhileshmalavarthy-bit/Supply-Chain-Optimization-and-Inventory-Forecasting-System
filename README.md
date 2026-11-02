# Supply Chain Optimization and Inventory Forecasting System

A full-stack, real-time dashboard for tracking multi-tenant inventory, forecasting product demand, monitoring supplier delivery performance, and recommending when to reorder stock — powered by **React**, **D3.js**, **Node.js + Express + WebSockets**, **Firebase Authentication**, and **Cloud Firestore** (`mystical-logic-zdtd0`).

## Problem Statement

Businesses need to know how much stock they have, how much customers may buy, and when to place replenishment orders. Poor inventory decisions can lead to:

- **Stockouts:** products become unavailable and sales may be lost.
- **Excess inventory:** money is tied up in products that sell slowly, and storage costs may increase.
- **Late supplier deliveries:** delays can cause stock shortages.
- **Manual guesswork:** spreadsheets and estimates can lead to inaccurate records and poor decisions.

This project brings inventory tracking and demand-planning information together in one dashboard to support better, data-driven decisions.

## Objectives

- Track stock levels for each product in real time.
- Estimate demand using historical sales data.
- Calculate reorder points automatically.
- Monitor supplier delivery performance.
- Display understandable stock alerts and reorder recommendations.

## Features

- **Dashboard:** key performance indicators, D3.js inventory status donut chart, 90-day demand analysis chart, supplier delivery chart, and low-stock alerts.
- **Product & Supplier Management:** add, edit, delete, search, and sort products and suppliers with full Cloud Firestore persistence.
- **Inventory Ledger:** record stock movements as `IN`, `OUT`, or `ADJUST` using atomic Firestore transactions (`runTransaction`) that prevent negative stock.
- **Demand Forecasting:** display a 14-day forecast with MAE evaluation (`maeMean` vs `maeNaive`) and save forecast snapshots to Firestore.
- **Low-Stock Alerts & Notifications:** show stock status using red, amber, and green indicators plus a live Firestore notifications drawer.
- **Recommendations & Stakeholder Reports:** provide reorder guidance with mathematical explanations, one-click PO queuing, CSV/JSON export, and saved report history in Firestore.
- **Security, RBAC & Multi-Tenant Isolation:** Google OAuth2 sign-in via Firebase Auth, Role-Based Access Control (`SUPER_ADMIN`, `OPS_MANAGER`, `INVENTORY_ANALYST`, `AUDITOR`), and a real-time Security Audit Log.

## Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS, D3.js (6 custom responsive charts), Lucide Icons
- **Backend & Real-Time Layer:** Node.js, Express, WebSockets (`ws`)
- **Persistent Database & Auth:** Firebase Authentication (Google Sign-In) & Cloud Firestore (`mystical-logic-zdtd0` / `ai-studio-supplychainoptim-c40ac3b4-a4fd-4ec9-89a0-697522847e9c`)

## How It Works

1. Product and supplier information is loaded from Cloud Firestore (`onSnapshot` real-time listeners) and displayed in the dashboard.
2. Inventory transactions record stock entering, leaving, or being adjusted atomically via Firestore transactions.
3. Historical demand is used to estimate demand for the next 14 days.
4. The system calculates reorder points using demand, supplier lead time, and safety stock.
5. Low-stock alerts and recommendations help users decide which products need replenishment.

### Reorder Point Formula

```text
Reorder Point = (Average Daily Demand × Lead Time in Days) + Safety Stock
```

**Example**

If average daily demand is 20 units, supplier lead time is 5 days, and safety stock is 30 units:

```text
Reorder Point = (20 × 5) + 30
              = 130 units
```

When stock reaches or falls below this level, the product is flagged for reorder.

### Stock Calculation

```text
Current Stock = Opening Stock + IN − OUT + Adjustments
```

The inventory ledger is used as the source for calculating stock balance.

---

## Cloud Firestore Collections, Authentication & Security Rules

### 1. Connected Firestore Collections

All business records are stored in Cloud Firestore under project `mystical-logic-zdtd0` (database `ai-studio-supplychainoptim-c40ac3b4-a4fd-4ec9-89a0-697522847e9c`):

| Collection Path | Purpose & Key Fields | Connected UI Operations |
|---|---|---|
| `/users/{userId}` | Private user profile (`uid`, `name`, `email`, `role`, `activeTenantId`, `createdAt`, `updatedAt`). Never stores passwords. | Created on sign-in; updated when switching RBAC role in **Security & Tenants**. |
| `/tenants/{tenantId}` | Multi-tenant workspace metadata (`id`, `ownerId`, `name`, `code`, `region`, `currencySymbol`, `status`, `today`, `createdAt`, `updatedAt`). | Workspace selector in sidebar & **Provision Isolated Tenant** form. |
| `/tenants/{tenantId}/products/{productId}` | Product catalogue (`id`, `sku`, `name`, `category`, `description`, `unit`, `cost`, `sellingPrice`, `status`, `lead`, `opening`, `safety`, `rop`, `sup`, `isSample`). | **Products** table, Add/Edit/Delete Product modals, Dashboard KPIs. |
| `/tenants/{tenantId}/inventory/{productId}` | Real-time stock balance & warehouse location (`productId`, `sku`, `productName`, `quantityOnHand`, `reorderLevel`, `safetyStock`, `warehouseLocation`, `status`, `lastUpdated`). | Updated atomically (`writeBatch` / `runTransaction`) on product save, ledger transaction, or PO receipt. |
| `/tenants/{tenantId}/suppliers/{supplierId}` | Approved vendor directory (`id`, `name`, `contactPerson`, `email`, `phone`, `address`, `status`, `isSample`). | **Suppliers Directory** table & Add/Edit/Delete Supplier modal on the **Products** page; Supplier performance metrics on **Dashboard** and **Analytics**. |
| `/tenants/{tenantId}/purchaseOrders/{poId}` | Supplier purchase orders (`id`, `sup`, `pid`, `productName`, `qty`, `unitPrice`, `total`, `od`, `ex`, `rc`, `st`, `isSample`). | **Quick PO** button in **Recommendations** and **Purchase Order Queue** (`Mark Received` / `Cancel`) in **Analytics**. |
| `/tenants/{tenantId}/inventoryTransactions/{txId}` | Immutable stock ledger entries (`id`, `pid`, `date`, `type`, `qty`, `note`, `relatedOrderId`, `actorEmail`, `isSample`, `createdAt`). | **Record Transaction** form and **Transaction History** table on the **Inventory** page. |
| `/tenants/{tenantId}/forecasts/{productId}` | 14-day demand forecast and 90-day historical demand series (`productId`, `sku`, `forecastPeriod`, `windowDays`, `historySeries`, `predictedDailyDemand`, `projectedPeriodTotal`, `method`, `maeMean`, `maeNaive`, `generatedAt`). | **Demand Forecast** evaluation chart and **Save Forecast to Firestore** button on the **Analytics** page. |
| `/tenants/{tenantId}/notifications/{notificationId}` | Stockout, low-stock, and PO notifications (`id`, `userId`, `message`, `type`, `relatedRecordId`, `read`, `createdAt`). | Top header **Alerts** dropdown (mark as read / delete); auto-created on low-stock or PO events. |
| `/tenants/{tenantId}/reports/{reportId}` | Saved stakeholder report history (`id`, `reportType`, `dateRange`, `summary`, `totalProducts`, `inventoryValue`, `belowRopCount`, `generatedBy`, `generatedAt`). | Automatically saved when exporting CSV/JSON reports; displayed in **Saved Stakeholder Reports History** on the **Recommendations** page. |
| `/tenants/{tenantId}/auditLogs/{logId}` | Immutable security and operational audit trail (`id`, `k`, `m`, `d`, `actorEmail`, `actorRole`, `severity`, `n`, `createdAt`). | **Recent Real-Time Activity Stream** on **Dashboard** and **Security Audit Log** table on **Security & Tenants**. |

*(Note: `salesOrders` and `warehouses` are not created as separate collections because outbound demand is tracked directly via `inventoryTransactions` (`OUT`) and `forecasts`, and warehouse locations are stored directly on each `inventory` record.)*

### 2. Sample Data Policy

- Initial demo records are seeded **only once** if a tenant workspace does not yet exist in Firestore.
- Existing Firestore records are **never overwritten** on page reload or sign-in.
- All initial demo documents include `isSample: true` and display a `SAMPLE` badge in the UI; any record added or edited by a user is saved with `isSample: false` and displays a green `LIVE` badge.

### 3. Authentication & Zero-Trust Firestore Security Rules (`firestore.rules`)

- **Authentication:** Uses Firebase Authentication with Google Sign-In (`signInWithPopup`).
- **Private User Profile Isolation:** `/users/{userId}` can only be read or updated by the profile owner (`request.auth.uid == userId`) or a verified administrator (`isAdmin()`).
- **Shared Company Data with Role-Based Access Control (RBAC):**
  - Authenticated company users with verified emails can read shared tenant data (`products`, `inventory`, `suppliers`, `purchaseOrders`, `inventoryTransactions`, `forecasts`, `notifications`, `reports`, `auditLogs`) when querying by `tenantId`.
  - Write permissions are enforced by role (`SUPER_ADMIN`, `OPS_MANAGER`, `INVENTORY_ANALYST`, `AUDITOR`) and validated by strict schema helpers (`isValid[Entity]`) that check field allowlists (`hasAll` / `hasOnly`), string bounds, non-negative stock/cost invariants, and server timestamps (`request.time`).

### 4. How to Verify Firestore Persistence

1. Click **Sign in with Google (Firestore)** in the top header or left sidebar.
2. Confirm the header status indicator changes to **`Firestore: PERSISTENT (mystical-logic-zdtd0)`**.
3. Go to **Products** and click **Add Product** (or edit an existing product, add a supplier, record an `IN`/`OUT` transaction in **Inventory**, queue/receive a PO in **Recommendations** / **Analytics**, or export a report).
4. Refresh the browser page (or sign out and sign back in).
5. Verify that your added/edited records, updated stock balances, and audit logs remain persisted from Cloud Firestore with the green **`LIVE`** badge.

---

## REST API Endpoints (`server.ts`)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | Retrieve initial workspace metadata and RBAC permissions |
| POST | `/api/firestore/sync-tenant` | Synchronize live Firestore snapshots with Express/WebSocket state |
| GET | `/api/products` | List products with current stock status |
| POST | `/api/products` | Add a product |
| PUT | `/api/products/:id` | Edit a product |
| DELETE | `/api/products/:id` | Remove a product |
| POST | `/api/transactions` | Record an IN, OUT, or ADJUST transaction |
| POST | `/api/purchase-orders` | Queue a new purchase order |
| PATCH | `/api/purchase-orders/:id` | Mark a purchase order as `received` or `cancelled` |
| GET | `/api/analytics/forecast` | Retrieve the 14-day demand forecast |
| GET | `/api/recommendations` | Retrieve reorder and risk recommendations |

## Team

- Narasimha
- Akhilesh
- Yuvaraj
- Shaheen

**Institution:** Mohan Babu University (MBU)

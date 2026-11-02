# Firestore Zero-Trust Security Specification (`security_spec.md`)

## 1. Data Invariants & Role-Based Access Control (RBAC)

1. **Default-Deny Catch-All**: All paths not explicitly matched in `firestore.rules` are denied (`allow read, write: if false;`).
2. **Verified Authentication (`isSignedIn`)**: Every read and write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **Private User Profile Isolation (`/users/{userId}`)**:
   - Contains `uid`, `name`, `email`, `role`, `activeTenantId`, `createdAt`, `updatedAt`. Passwords are never stored in Firestore.
   - `get` and `list` are strictly restricted to the profile owner (`request.auth.uid == userId`) or `isAdmin()`. Users cannot read or modify another user's private profile.
   - Non-admin users cannot escalate their own `role` during profile creation or update.
4. **Shared Company Tenant Workspaces & RBAC (`/tenants/{tenantId}/...`)**:
   - Company inventory data (`products`, `inventory`, `suppliers`, `purchaseOrders`, `inventoryTransactions`, `forecasts`, `notifications`, `reports`, `auditLogs`) is shared across authenticated company users according to their RBAC role (`SUPER_ADMIN`, `OPS_MANAGER`, `INVENTORY_ANALYST`, `AUDITOR`) rather than isolating company inventory by a single user's UID:
     - `SUPER_ADMIN` / `isAdmin()` / Tenant Owner: Full CRUD across products, suppliers, inventory, purchase orders, forecasts, notifications, reports, and tenant workspaces.
     - `OPS_MANAGER`: Create/update products, suppliers, inventory, purchase orders, forecasts, notifications, and reports (cannot delete products or manage tenants).
     - `INVENTORY_ANALYST`: Record inventory transactions, update inventory stock, generate forecasts, and save reports.
     - `AUDITOR`: Read-only access to company inventory, analytics, and audit logs, plus saving stakeholder audit reports.
5. **Strict Blueprint Validation (`isValid[Entity]`)**:
   - Every `create` and `update` invokes its dedicated `isValid[Entity](incoming())` helper enforcing `hasAll`, `hasOnly`, type safety, bounded string lengths, non-negative prices/stock (`quantityOnHand >= 0`), and server timestamps (`request.time`).
6. **Query Enforcer (`allow list`)**:
   - Every `allow list` rule on tenant subcollections enforces `existing().tenantId == tenantId` without `get()` or `exists()` calls to prevent O(N) read cost explosions.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unverified Email Spoof**: Token with `email: 'akhileshmalavarthy@gmail.com'` and `email_verified: false` -> `PERMISSION_DENIED`.
2. **Cross-User Profile Read (PII Leak)**: User `uid_b` attempting `get(/users/uid_a)` -> `PERMISSION_DENIED`.
3. **Self-Privilege Escalation**: Non-admin user creating `/users/uid_b` with `role: 'SUPER_ADMIN'` -> `PERMISSION_DENIED`.
4. **Password Field Injection**: Creating `/users/uid_a` with a `password` or `passwordHash` shadow key -> `PERMISSION_DENIED` (`hasOnly` guard).
5. **ID Poisoning Attack**: Creating a product or PO with a 500-character ID or special characters -> `PERMISSION_DENIED` (`isValidId` guard).
6. **Negative Inventory Stock**: Creating or updating `/tenants/tenant-in-01/inventory/1` with `quantityOnHand: -10` -> `PERMISSION_DENIED`.
7. **Shadow Field Injection on Product Update**: Updating `/tenants/tenant-in-01/products/1` with `isVerified: true` -> `PERMISSION_DENIED`.
8. **Forged Client Timestamp**: Creating a transaction with a past/future `createdAt != request.time` -> `PERMISSION_DENIED`.
9. **Auditor Unauthorized Product Write**: User with role `AUDITOR` attempting to create or delete a product -> `PERMISSION_DENIED`.
10. **Terminal Purchase Order Mutation**: Non-admin attempting to modify a `received` or `cancelled` PO -> `PERMISSION_DENIED`.
11. **Unbounded Forecast Array Exhaustion**: Creating a `forecasts` doc with `historySeries` of 5,000 elements -> `PERMISSION_DENIED` (`historySeries.size() <= 90`).
12. **Immutable Ledger Tampering**: Attempting `update` on an existing `inventoryTransactions` or `auditLogs` document -> `PERMISSION_DENIED` (`allow update: if false;`).

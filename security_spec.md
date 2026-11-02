# Firestore Zero-Trust Security Specification (`security_spec.md`)

## 1. Data Invariants & Relational Ownership

1. **Global Default-Deny**: All paths not explicitly matched deny all `read` and `write` operations.
2. **Verified Authentication**: Every read and write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **Master Gate (Relational Sync)**:
   - `/tenants/{tenantId}` is the parent resource owned by `ownerId` (`ownerId == request.auth.uid || isAdmin()`).
   - Every subcollection document (`products`, `transactions`, `purchaseOrders`, `auditLogs`) must reference a valid existing `/tenants/{tenantId}` where the caller is the tenant owner or a verified admin (`isTenantOwner(tenantId) || isAdmin()`).
4. **Strict Blueprint Validation (`isValid[Entity]`)**:
   - Every `create` and `update` operation invokes its `isValid[Entity](incoming())` helper, enforcing `.keys().hasAll(...)`, `.keys().hasOnly(...)`, string `.size()` bounds, regex patterns, and `ownerId == request.auth.uid`.
5. **Action-Based Updates & Terminal State Locking**:
   - `PurchaseOrderDoc` cannot be updated by non-admins once `existing().st` reaches a terminal state (`'received'` or `'cancelled'`).
   - `TransactionDoc` and `AuditLogDoc` are append-only immutable ledgers (updates denied except admin emergency override).
6. **Temporal Integrity**:
   - All `createdAt` fields must equal `request.time` on creation and remain immutable (`incoming().createdAt == existing().createdAt`) on update.
   - All `updatedAt` fields must equal `request.time` on creation and update.
7. **Query Enforcer (Secure List Queries)**:
   - Every `allow list` rule enforces `resource.data.ownerId == request.auth.uid || isAdmin()` without performing O(N) `get()` calls on child documents.

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 (Shadow Field Injection)**: Creating a `ProductDoc` with an undeclared field `"isVerified": true`. Rejected by `data.keys().hasOnly(...)`.
2. **Payload 2 (Identity Spoofing)**: Creating a `TenantWorkspaceDoc` with `ownerId: "victim_uid_999"` when `request.auth.uid == "attacker_uid_111"`. Rejected by `data.ownerId == request.auth.uid`.
3. **Payload 3 (Unverified Email Admin Spoof)**: Calling an admin route with `request.auth.token.email == "akhileshmalavarthy@gmail.com"` and `email_verified == false`. Rejected by `request.auth.token.email_verified == true`.
4. **Payload 4 (Self-Assigned Privilege Escalation)**: Creating a `UserProfileDoc` with `role: "SUPER_ADMIN"` as a non-admin user. Rejected by `data.role == 'INVENTORY_ANALYST' || isAdmin()`.
5. **Payload 5 (ID Poisoning / Denial of Wallet)**: Creating `/tenants/{tenantId}` where `tenantId` is a 1,500-character string or contains special characters (`../`). Rejected by `isValidId(tenantId)`.
6. **Payload 6 (Orphaned Subcollection Write)**: Creating `/tenants/non_existent_tenant/products/1` where `/tenants/non_existent_tenant` does not exist. Rejected by `isTenantAccessAllowed(tenantId)` master gate.
7. **Payload 7 (Update-Gap / Value Poisoning)**: Updating an allowed key `name` on `ProductDoc` with a 50,000-character string or boolean. Rejected because `isValidProductDoc(incoming())` wraps the entire `allow update` block.
8. **Payload 8 (Immortal Field Mutation)**: Updating `createdAt` or `ownerId` on `/tenants/{tenantId}/products/{productId}`. Rejected by `incoming().createdAt == existing().createdAt && incoming().ownerId == existing().ownerId`.
9. **Payload 9 (Client Timestamp Forgery)**: Creating a `TransactionDoc` with a backdated or future `createdAt` timestamp instead of `request.time`. Rejected by `incoming().createdAt == request.time`.
10. **Payload 10 (Terminal State Unlocking)**: Attempting to update a `PurchaseOrderDoc` whose `existing().st == 'received'` back to `'pending'`. Rejected by terminal state lock `existing().st == 'pending'`.
11. **Payload 11 (Ledger Tampering)**: Attempting to `update` an existing `TransactionDoc` or `AuditLogDoc` as a regular user. Rejected by immutable ledger rules (`allow update: if false;`).
12. **Payload 12 (Blanket List Scraping)**: Attempting an unconstrained `list` query on `/tenants/{tenantId}/products` belonging to another user's tenant. Rejected by `resource.data.ownerId == request.auth.uid || isAdmin()`.

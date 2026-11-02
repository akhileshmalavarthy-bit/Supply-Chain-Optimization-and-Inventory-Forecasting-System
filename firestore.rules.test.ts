/**
 * Firestore Security Rules Test Specification (Dirty Dozen Verification)
 * Verifies that all 12 adversarial payloads described in security_spec.md
 * return PERMISSION_DENIED under Zero-Trust ABAC rules.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Shadow Field Injection on ProductDoc',
    operation: 'create',
    path: '/tenants/tenant-in-01/products/1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      id: 1,
      tenantId: 'tenant-in-01',
      ownerId: 'user_1',
      sku: 'LAP-001',
      name: 'Laptop',
      cost: 50000,
      lead: 5,
      opening: 40,
      safety: 20,
      rop: 65,
      base: 10,
      sup: 1,
      isVerified: true, // Ghost field
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Identity Spoofing on TenantWorkspaceDoc',
    operation: 'create',
    path: '/tenants/tenant-in-01',
    auth: { uid: 'attacker_1', email: 'attacker@example.com', email_verified: true },
    payload: {
      id: 'tenant-in-01',
      ownerId: 'victim_99',
      name: 'Apex India',
      code: 'APX-IN',
      region: 'Mumbai',
      currencySymbol: '₹',
      currencyLocale: 'en-IN',
      today: '2026-10-27',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Unverified Email Admin Spoof',
    operation: 'get',
    path: '/admins/admin_1',
    auth: {
      uid: 'spoof_admin',
      email: 'akhileshmalavarthy@gmail.com',
      email_verified: false,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Self-Assigned SUPER_ADMIN Privilege Escalation',
    operation: 'create',
    path: '/users/user_2',
    auth: { uid: 'user_2', email: 'user2@example.com', email_verified: true },
    payload: {
      uid: 'user_2',
      name: 'Regular User',
      role: 'SUPER_ADMIN',
      activeTenantId: 'tenant-in-01',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'ID Poisoning with 200-char Document ID',
    operation: 'create',
    path: `/tenants/${'a'.repeat(200)}`,
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {},
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Orphaned Subcollection Write to Non-Existent Tenant',
    operation: 'create',
    path: '/tenants/missing-tenant-99/products/1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {},
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Value Poisoning on Whitelisted Update Key',
    operation: 'update',
    path: '/tenants/tenant-in-01/products/1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      name: 'X'.repeat(500), // Exceeds maxLength 60
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immortal Field Mutation (ownerId change)',
    operation: 'update',
    path: '/tenants/tenant-in-01/products/1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      ownerId: 'other_user',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Client Timestamp Forgery on TransactionDoc',
    operation: 'create',
    path: '/tenants/tenant-in-01/transactions/1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      createdAt: '1999-01-01T00:00:00Z',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Terminal State Unlocking on Received PurchaseOrderDoc',
    operation: 'update',
    path: '/tenants/tenant-in-01/purchaseOrders/PO-1001',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      st: 'pending',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Immutable Ledger Tampering on AuditLogDoc',
    operation: 'update',
    path: '/tenants/tenant-in-01/auditLogs/1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    payload: {
      m: 'Forged audit log message',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Cross-Tenant Unauthorized List Scraping',
    operation: 'list',
    path: '/tenants/tenant-in-01/products',
    auth: { uid: 'outsider_uid', email: 'outsider@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
];

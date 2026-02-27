// Branded types prevent accidentally passing one kind of ID where another is expected.
// The __brand field exists only at the type level — no runtime cost.
type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type GroupId = Brand<string, 'GroupId'>;
export type PageId = Brand<string, 'PageId'>;

// Type-safe constructors for branded IDs
export const UserId = (id: string) => id as UserId;
export const GroupId = (id: string) => id as GroupId;
export const PageId = (id: string) => id as PageId;

// Permission levels ordered by privilege: none < read < write < full_access
export const PERMISSION_LEVELS = ['none', 'read', 'write', 'full_access'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

// Numeric ordering for comparisons
const LEVEL_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  full_access: 3,
};

export function comparePermissionLevels(a: PermissionLevel, b: PermissionLevel): number {
  return LEVEL_ORDER[a] - LEVEL_ORDER[b];
}

export function isAtLeast(actual: PermissionLevel, required: PermissionLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[required];
}

export function maxPermissionLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

// Discriminated union for resolution results.
// Forces exhaustive handling everywhere a result is consumed.
export type ResolvedPermission =
  | { kind: 'direct'; level: PermissionLevel; pageId: PageId }
  | { kind: 'inherited'; level: PermissionLevel; fromPageId: PageId; depth: number }
  | { kind: 'no_access' };

export function resolvedPermissionLevel(result: ResolvedPermission): PermissionLevel {
  switch (result.kind) {
    case 'direct':
    case 'inherited':
      return result.level;
    case 'no_access':
      return 'none';
  }
}

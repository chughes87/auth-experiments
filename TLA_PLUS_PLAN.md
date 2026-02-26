# TLA+ Specification Plan

## Overview

If time permits, formally model the resolution algorithm in TLA+ and verify invariants (denial supremacy, depth monotonicity, cycle safety, move safety) with the TLC model checker. A small model (3 users, 2 groups, 4 pages) is sufficient — TLC exhaustively checks all reachable states, unlike property-based testing which samples randomly. The TLA+ spec would also serve as a precise reference for the fast-check in-memory oracle.

## Tasks [Not Started]

- [ ] Model resolution as a pure TLA+ operator
- [ ] Define invariants, run TLC against small model

## Files

- `specs/PermissionResolution.tla` — TLA+ formal specification of resolution algorithm
- `specs/PermissionResolution.cfg` — TLC model checker configuration

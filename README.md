# Fusebox (working name)

Two tools for one problem on Sui: accounting bugs and forgotten code keep draining protocols, and audits keep missing them.

| Folder | What it is | State |
| --- | --- | --- |
| `fuse/` | Move library. Custody with invariants that cannot be skipped. | 13 unit tests pass |
| `fuse_example/` | A rewards pool with a real bug, protected by `fuse`. | 8 unit tests pass |
| `scanner/` | CLI that finds old package versions which can still modify live objects. | 20 tests pass; full mainnet scan run on Cetus (15 versions) |

Built and tested with Sui CLI 1.83.1 and Node 22.

## 1. `fuse`: the invariant guard

A protocol stores its funds in a `fuse::Vault<T>` instead of a bare `Balance<T>`. Every change to the vault needs a `Ticket`. A `Ticket` has no abilities, so Move will not let it be stored, copied or dropped: the only way to finish the transaction is to pass it to `settle`, and `settle` checks the rules. A broken rule aborts the whole transaction.

Rules checked at `settle`:

1. **Solvency:** `balance + receivables >= claims`. The protocol cannot owe more than it has.
2. **Transaction floor:** one transaction cannot take the balance below a set share of where it found it.
3. **Epoch floor:** the same, measured across an epoch (about 24 hours), so a drain split into many small transactions is capped too.

```move
let ticket = fuse::open(&mut pool.vault, ctx);
fuse::remove_claims(&mut pool.vault, &ticket, amount);
let paid = fuse::withdraw(&mut pool.vault, &ticket, amount);
fuse::settle(&pool.vault, ticket);
```

A function can also return the ticket to its caller. The rules are then checked when the caller's whole transaction ends, which is how `flash_borrow` / `flash_repay` in the example work.

### What the example proves

`fuse_example::rewards_pool` has a function, `update_points`, with a missing check: anyone can give themselves any number of points, redeemable 1:1 for SUI. The tests show:

- minting more points than the pool holds aborts with `EInsolvent`;
- minting only what the pool can cover, then redeeming it all, aborts with `ETxOutflow`;
- splitting that drain across transactions aborts with `EEpochOutflow` after 40% of the pool, not 100%;
- honest redemptions and repaid flash loans pass.

### Run the tests

```powershell
cd fuse
sui move test
cd ..\fuse_example
sui move test
```

### Limits of the guard, as it stands

- The rules fit protocols that keep a ledger of what they owe in the asset's own units: reward pools, deposit ledgers, margin accounts. An AMM's invariant (the kind of bug behind the Cetus exploit) needs a different rule and is not covered yet.
- The outflow limits also stop a large honest withdrawal. Each protocol has to choose limits it can live with; `10000` switches a limit off.
- It only protects funds that are inside the vault and claims the protocol reports to it. A protocol that keeps a second, unguarded balance gets no protection for that balance.
- Not audited. Do not put real funds behind it yet.

## 2. `scanner`: the legacy code finder

On Sui an upgrade publishes a new package and leaves every earlier version on chain and callable. Types keep their identity across versions, so a function in version 1 accepts the same shared object that version 15 uses. Unless the old function checks a version number and refuses to run, a bug fixed in the latest version is still open in the old one.

The scanner downloads every version of a package, and for each old function that anyone can call and that can actually modify one of the package's own objects, it answers two questions. "Can actually modify" means the function, or package code it reaches, takes a mutable borrow of a field (only the defining package can do that), or takes the object by value. A function that takes `&mut Pool` but only reads it, or that always aborts, is left out.



- **Is there a version check?** It looks for the usual patterns: reading a field named `version`, calling a function or module named for version checking, or taking a `Version` object.
- **Is the logic stale?** It compares the function, and all the package code it calls, with the latest version.

| Severity | Meaning |
| --- | --- |
| HIGH | No version check, callable by anyone, the latest version changed or removed this logic, and it can pay coins out. |
| MED | Same, but it has no path that takes coins out. It can still change protocol state with outdated rules. |
| LOW | Same, but the caller needs a capability object (`AdminCap` and similar) or is checked against a role or access list. |
| INFO | No version check, but the logic is identical to the latest version. |

When the latest version replaces a function with one that always aborts, the report labels the drift `disabled`: the old copy is then the only one that still runs.

### Run it

Needs Node 20 or newer.

```powershell
cd scanner
npm install
npm run build
node dist/src/cli.js scan 0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb
```

That address is the Cetus CLMM package, which has 15 versions on mainnet. Any version's address works. Other options:

```powershell
node dist/src/cli.js scan <address> --network testnet
node dist/src/cli.js scan <address> --json
node dist/src/cli.js scan <address> --md report.md
node dist/src/cli.js scan --dir test/fixtures/legacy_pool/bytecode
npm test
```

The exit code is 1 when a HIGH finding exists, so the scan can gate a CI job.

### Limits of the scanner, as it stands

- **A HIGH finding is a lead, not proof of an exploit.** Version checks and role checks are found by naming patterns, and "can pay out" means a reachable call to `balance::split`, `coin::take` or similar. A protocol that gates old code some other way will be reported even though it is safe, and one that names an unrelated field `version` will be passed even though it is not.
- **"Changed" means the bytecode differs.** Recompiling the same source with a newer compiler can change bytecode, which would show as changed logic. Line-number shifts are already ignored.
- **It does not look at live objects yet.** It does not know whether the object a function modifies is shared, how much it holds, or whether the object's version number was moved on. That is the next step, and it is what turns a list of functions into "dollars at risk".
- **The GraphQL queries were checked by hand against mainnet** (version listing, per-version fetch, module decoding), and the analysis is tested on a compiled two-version fixture.

### First real scan: Cetus CLMM (15 versions)

No HIGH findings. Nothing in an old version gives anyone a way to take coins out.

| Severity | Function | What it really does |
| --- | --- | --- |
| MED | `partner::receive_ref_fee` (v1 to v12) | Adds the caller's own `Balance` to a partner's fee bag. Coins only go in. Cetus disabled it from v13, but the old copies still accept deposits. Not a risk to funds. |
| LOW | `pool::update_pool` (v7) | Adds coins to a pool. The caller is checked with `config::check_pool_manager_role`. |

The first run of this scan reported 6 HIGH findings. All were false alarms, and they led to the current rules. Most of the functions only took coins in or only read state, and several old copies just abort. From v13 on, Cetus replaced most of the old entry points with functions that always abort, and the old copies of the functions that still matter are version-checked.

## Next steps

1. Run the scanner on real packages and review what it reports. Expect to tune the version-check patterns.
2. Add the live-object pass: which flagged types have shared objects, and what they hold.
3. Build the public exposure map from scanner output.
4. Add an AMM rule set to `fuse`, then get the library audited.
